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

    const { data: callerProfile, error: profErr } = await adminClient
      .from("profiles")
      .select("id, role")
      .eq("id", callerData.user.id)
      .maybeSingle();

    if (profErr || !callerProfile) {
      return json({ error: "Caller profile missing" }, 403);
    }

    const isAdmin = callerProfile.role === "admin";
    const isManager = callerProfile.role === "manager";
    if (!isAdmin && !isManager) {
      return json({ error: "Admin or manager only" }, 403);
    }

    const { email } = await req.json();
    if (!email || typeof email !== "string") {
      return json({ error: "Email is required" }, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return json({ error: "Enter a valid email address" }, 400);
    }

    const { data: targetProfile } = await adminClient
      .from("profiles")
      .select("id, manager_id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (!targetProfile?.id) {
      return json({ error: "No team member found with that email" }, 404);
    }

    if (isManager) {
      // Recursive downline check (reports + reports-of-reports)
      const { data: allProfiles, error: treeErr } = await adminClient
        .from("profiles")
        .select("id, manager_id");
      if (treeErr) return json({ error: treeErr.message }, 400);

      const byManager = new Map<string, string[]>();
      for (const row of allProfiles || []) {
        if (!row.manager_id) continue;
        const list = byManager.get(row.manager_id) || [];
        list.push(row.id);
        byManager.set(row.manager_id, list);
      }
      const downline = new Set<string>();
      const stack = [...(byManager.get(callerProfile.id) || [])];
      while (stack.length) {
        const id = stack.pop()!;
        if (downline.has(id)) continue;
        downline.add(id);
        const kids = byManager.get(id);
        if (kids?.length) stack.push(...kids);
      }

      if (!downline.has(targetProfile.id)) {
        return json({ error: "You can only reset passwords for people in your downline" }, 403);
      }
    }

    const redirectTo = authRedirectTo(appUrl);
    const { error: resetErr } = await adminClient.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo,
    });

    if (resetErr) {
      return json({ error: resetErr.message }, 400);
    }

    return json({ ok: true, email: normalizedEmail });
  } catch (e) {
    return json({ error: (e as Error)?.message || "Unknown error" }, 500);
  }
});
