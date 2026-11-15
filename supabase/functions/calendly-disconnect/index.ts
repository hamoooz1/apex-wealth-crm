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

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const res = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Refresh token failed (${res.status}): ${txt}`);
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

  const uid = userRes.user.id;
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: conn, error: connErr } = await supabaseAdmin
    .from("calendly_connections")
    .select("id, webhook_subscription_uri")
    .eq("user_id", uid)
    .is("revoked_at", null)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn?.id) return json({ ok: true, disconnected: false, reason: "no_active_connection" }, { headers: cors });

  const { data: tok, error: tokErr } = await supabaseAdmin
    .from("calendly_connection_tokens")
    .select("access_token, refresh_token")
    .eq("connection_id", conn.id)
    .maybeSingle();
  if (tokErr) throw tokErr;

  let accessToken = tok?.access_token as string | undefined;
  const refreshToken = tok?.refresh_token as string | undefined;

  if (conn.webhook_subscription_uri && (accessToken || refreshToken)) {
    if (!accessToken && refreshToken) {
      const refreshed = await refreshAccessToken(CALENDLY_CLIENT_ID, CALENDLY_CLIENT_SECRET, refreshToken);
      accessToken = refreshed.access_token;
      await supabaseAdmin
        .from("calendly_connection_tokens")
        .update({ access_token: accessToken, refresh_token: refreshed.refresh_token ?? refreshToken })
        .eq("connection_id", conn.id);
    }

    if (accessToken) {
      try {
        await fetch(conn.webhook_subscription_uri, {
          method: "DELETE",
          headers: { authorization: `Bearer ${accessToken}` },
        });
      } catch {
        // ignore
      }
    }
  }

  await supabaseAdmin
    .from("calendly_connections")
    .update({ status: "disconnected", revoked_at: new Date().toISOString(), webhook_subscription_uri: null })
    .eq("id", conn.id);

  await supabaseAdmin.from("calendly_connection_tokens").delete().eq("connection_id", conn.id);

  return json({ ok: true, disconnected: true }, { headers: cors });
});
