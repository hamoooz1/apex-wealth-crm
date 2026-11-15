import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncCalendlyConnection } from "../_shared/calendlyMeetings.ts";
import { corsHeaders, json } from "../_shared/http.ts";

// verify_jwt: true. Syncs the signed-in advisor. The scheduled job uses integration-reconcile.

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405, headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const CALENDLY_CLIENT_ID = Deno.env.get("CALENDLY_CLIENT_ID");
  const CALENDLY_CLIENT_SECRET = Deno.env.get("CALENDLY_CLIENT_SECRET");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing Supabase env" }, { status: 500, headers: cors });
  }
  if (!CALENDLY_CLIENT_ID || !CALENDLY_CLIENT_SECRET) {
    return json({ error: "Missing Calendly client env" }, { status: 500, headers: cors });
  }

  const authHeader = req.headers.get("authorization") || "";
  const supabaseAuthed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userRes, error: userErr } = await supabaseAuthed.auth.getUser();
  if (userErr || !userRes?.user?.id) return json({ error: "Unauthorized" }, { status: 401, headers: cors });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: conn, error: connErr } = await supabaseAdmin
    .from("calendly_connections")
    .select("id, user_id, calendly_user_uri")
    .eq("user_id", userRes.user.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn?.id || !conn.calendly_user_uri) {
    return json({ error: "No active Calendly connection. Connect Calendly in Settings." }, { status: 409, headers: cors });
  }

  try {
    const stats = await syncCalendlyConnection(
      supabaseAdmin,
      { id: conn.id, user_id: conn.user_id, calendly_user_uri: conn.calendly_user_uri },
      { clientId: CALENDLY_CLIENT_ID, clientSecret: CALENDLY_CLIENT_SECRET },
    );
    return json({ ok: true, ...stats }, { headers: cors });
  } catch (e) {
    return json({ error: (e as Error).message || "Calendly sync failed" }, { status: 502, headers: cors });
  }
});
