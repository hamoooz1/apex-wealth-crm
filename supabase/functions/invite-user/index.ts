/// <reference deno.land/x/types/index.d.ts />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authRedirectTo, resolveAppUrl } from "../_shared/appUrl.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const appUrl = resolveAppUrl();
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return json({ error: "Missing bearer token" }, 401);
    }

    const { data: callerData, error: callerErr } = await adminClient.auth.getUser(token);
    if (callerErr || !callerData?.user) {
      return json({ error: "Invalid session" }, 401);
    }

    const callerId = callerData.user.id;

    const { data: callerProfile, error: profErr } = await adminClient
      .from("profiles")
      .select("id, role")
      .eq("id", callerId)
      .maybeSingle();

    if (profErr || !callerProfile) {
      return json({ error: "Caller profile missing" }, 403);
    }

    const callerRole = callerProfile.role;
    const isAdmin = callerRole === "admin";
    const isManager = callerRole === "manager";
    if (!isAdmin && !isManager) {
      return json({ error: "Admin or manager only" }, 403);
    }

    const { email, full_name, role, manager_id } = await req.json();

    if (!email || typeof email !== "string") {
      return json({ error: "Email is required" }, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return json({ error: "Enter a valid email address" }, 400);
    }

    let inviteRole =
      role === "admin" || role === "manager" || role === "advisor" ? role : "advisor";
    let managerId: string | null = manager_id || null;

    // Managers may only invite advisors onto their own team.
    if (isManager) {
      inviteRole = "advisor";
      managerId = callerId;
    }

    if (managerId) {
      const { data: mgr } = await adminClient
        .from("profiles")
        .select("id, role")
        .eq("id", managerId)
        .maybeSingle();
      if (!mgr?.id) {
        return json({ error: "Selected manager was not found" }, 400);
      }
      if (mgr.role !== "admin" && mgr.role !== "manager") {
        return json({ error: "Manager must be an admin or manager" }, 400);
      }
    }

    const userMeta = {
      full_name: full_name || "",
      role: inviteRole,
      manager_id: managerId,
    };
    const redirectTo = authRedirectTo(appUrl);

    async function syncProfile(userId: string) {
      const { error: updateErr } = await adminClient
        .from("profiles")
        .update({
          full_name: full_name?.trim() || normalizedEmail.split("@")[0],
          email: normalizedEmail,
          role: inviteRole,
          manager_id: managerId,
          is_active: true,
        })
        .eq("id", userId);
      if (updateErr) throw updateErr;
    }

    const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
      normalizedEmail,
      {
        data: userMeta,
        redirectTo,
      },
    );

    if (inviteErr) {
      const msg = inviteErr.message || "Invite failed";
      const alreadyExists = /already|registered|exists/i.test(msg);

      if (alreadyExists) {
        const { data: existingProfile } = await adminClient
          .from("profiles")
          .select("id")
          .eq("email", normalizedEmail)
          .maybeSingle();

        if (existingProfile?.id) {
          await syncProfile(existingProfile.id);
          return json({
            ok: true,
            user_id: existingProfile.id,
            existing: true,
            message:
              "This user already exists. Their profile was updated. If they cannot sign in, ask them to use Forgot password or their original invite email.",
          });
        }
      }

      return json({ error: msg }, 400);
    }

    const invitedId = invited.user?.id;
    if (!invitedId) {
      return json({ error: "Invite failed (no user id)" }, 500);
    }

    try {
      await syncProfile(invitedId);
    } catch (e) {
      return json({ error: (e as Error).message || "Profile update failed" }, 400);
    }

    return json({ ok: true, user_id: invitedId });
  } catch (e) {
    return json({ error: (e as Error)?.message || "Unknown error" }, 500);
  }
});
