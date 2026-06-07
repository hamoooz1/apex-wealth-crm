/// <reference deno.land/x/types/index.d.ts />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const appUrl = Deno.env.get("APP_URL") || "";
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
    if (callerProfile.role !== "admin") {
      return json({ error: "Admin only" }, 403);
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
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (!targetProfile?.id) {
      return json({ error: "No team member found with that email" }, 404);
    }

    const redirectTo = appUrl ? `${appUrl.replace(/\/$/, "")}/` : undefined;
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
