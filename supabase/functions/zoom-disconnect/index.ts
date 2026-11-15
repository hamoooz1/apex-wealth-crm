import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405, headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ZOOM_CLIENT_ID = Deno.env.get("ZOOM_CLIENT_ID");
  const ZOOM_CLIENT_SECRET = Deno.env.get("ZOOM_CLIENT_SECRET");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing Supabase env" }, { status: 500, headers: cors });
  }

  const authHeader = req.headers.get("authorization") || "";
  const supabaseAuthed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userRes, error: userErr } = await supabaseAuthed.auth.getUser();
  if (userErr || !userRes?.user?.id) return json({ error: "Unauthorized" }, { status: 401, headers: cors });

  const uid = userRes.user.id;
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: conn, error: connErr } = await supabaseAdmin
    .from("zoom_connections")
    .select("id")
    .eq("user_id", uid)
    .is("revoked_at", null)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn?.id) return json({ ok: true, disconnected: false, reason: "no_active_connection" }, { headers: cors });

  const { data: tok } = await supabaseAdmin
    .from("zoom_connection_tokens")
    .select("access_token")
    .eq("connection_id", conn.id)
    .maybeSingle();

  // Best-effort token revoke at Zoom
  if (tok?.access_token && ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET) {
    try {
      const basic = btoa(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`);
      await fetch(`https://zoom.us/oauth/revoke?token=${encodeURIComponent(tok.access_token)}`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}` },
      });
    } catch {
      // ignore
    }
  }

  await supabaseAdmin
    .from("zoom_connections")
    .update({ status: "disconnected", revoked_at: new Date().toISOString() })
    .eq("id", conn.id);

  await supabaseAdmin.from("zoom_connection_tokens").delete().eq("connection_id", conn.id);

  return json({ ok: true, disconnected: true }, { headers: cors });
});
