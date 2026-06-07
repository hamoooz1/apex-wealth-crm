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

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Zoom token refresh failed (${res.status}): ${txt.slice(0, 180)}`);
  }
  return await res.json();
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
  if (!ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    return json({ error: "Missing Zoom client env" }, { status: 500, headers: cors });
  }

  const authHeader = req.headers.get("authorization") || "";
  const supabaseAuthed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userRes, error: userErr } = await supabaseAuthed.auth.getUser();
  if (userErr || !userRes?.user?.id) return json({ error: "Unauthorized" }, { status: 401, headers: cors });
  const uid = userRes.user.id;

  let body: { title?: string; start_time?: string; duration?: number; timezone?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }
  const title = (body.title || "Meeting").toString().slice(0, 200);
  const startTime = body.start_time;
  const duration = Math.max(5, Math.min(1440, Number(body.duration || 30)));
  const timezone = body.timezone || "UTC";
  if (!startTime || Number.isNaN(new Date(startTime).getTime())) {
    return json({ error: "Valid start_time (ISO 8601) is required" }, { status: 400, headers: cors });
  }

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
  if (!conn?.id) return json({ error: "No active Zoom connection. Connect Zoom in Settings." }, { status: 409, headers: cors });

  const { data: tok, error: tokErr } = await supabaseAdmin
    .from("zoom_connection_tokens")
    .select("access_token, refresh_token, token_expires_at")
    .eq("connection_id", conn.id)
    .maybeSingle();
  if (tokErr) throw tokErr;
  if (!tok?.access_token && !tok?.refresh_token) {
    return json({ error: "Zoom tokens missing. Reconnect Zoom in Settings." }, { status: 409, headers: cors });
  }

  let accessToken = tok.access_token as string | undefined;
  const expMs = tok.token_expires_at ? new Date(tok.token_expires_at).getTime() : 0;
  const needsRefresh = !accessToken || expMs - Date.now() < 60_000;
  if (needsRefresh && tok.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, tok.refresh_token);
      accessToken = refreshed.access_token;
      await supabaseAdmin
        .from("zoom_connection_tokens")
        .update({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token ?? tok.refresh_token,
          token_expires_at: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000).toISOString(),
        })
        .eq("connection_id", conn.id);
    } catch (e) {
      return json({ error: (e as Error).message || "Token refresh failed" }, { status: 502, headers: cors });
    }
  }

  const createRes = await fetch("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      topic: title,
      type: 2,
      start_time: startTime,
      duration,
      timezone,
      settings: {
        join_before_host: false,
        waiting_room: true,
        host_video: true,
        participant_video: false,
        mute_upon_entry: true,
        approval_type: 2,
        auto_recording: "cloud",
      },
    }),
  });
  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => "");
    return json({ error: `Zoom create meeting failed (${createRes.status}): ${txt.slice(0, 220)}` }, { status: 502, headers: cors });
  }
  const m = await createRes.json();

  return json(
    {
      ok: true,
      zoom_meeting_id: String(m.id),
      join_url: m.join_url,
      start_url: m.start_url,
      passcode: m.password ?? null,
      start_time: m.start_time ?? startTime,
      duration: m.duration ?? duration,
      timezone: m.timezone ?? timezone,
    },
    { headers: cors },
  );
});
