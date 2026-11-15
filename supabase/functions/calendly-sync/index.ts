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

function meetingUrlFromLocation(location: any): string | null {
  if (!location) return null;
  if (typeof location === "string") return location;
  if (typeof location?.join_url === "string") return location.join_url;
  if (typeof location?.location === "string") return location.location;
  if (typeof location?.uri === "string") return location.uri;
  return null;
}

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
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
    throw new Error(`Calendly token refresh failed (${res.status}): ${txt.slice(0, 180)}`);
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
    .select("id, calendly_user_uri")
    .eq("user_id", uid)
    .is("revoked_at", null)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn?.id || !conn?.calendly_user_uri) {
    return json({ error: "No active Calendly connection. Connect Calendly in Settings." }, { status: 409, headers: cors });
  }

  const { data: tok, error: tokErr } = await supabaseAdmin
    .from("calendly_connection_tokens")
    .select("access_token, refresh_token, token_expires_at")
    .eq("connection_id", conn.id)
    .maybeSingle();
  if (tokErr) throw tokErr;
  if (!tok?.access_token && !tok?.refresh_token) {
    return json({ error: "Calendly tokens missing. Reconnect Calendly." }, { status: 409, headers: cors });
  }

  let accessToken = tok.access_token as string | undefined;
  const expMs = tok.token_expires_at ? new Date(tok.token_expires_at).getTime() : 0;
  if ((!accessToken || expMs - Date.now() < 60_000) && tok.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(CALENDLY_CLIENT_ID, CALENDLY_CLIENT_SECRET, tok.refresh_token);
      accessToken = refreshed.access_token;
      await supabaseAdmin
        .from("calendly_connection_tokens")
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

  // Window: 30 days back through 90 days ahead
  const minStart = new Date(Date.now() - 30 * 86400000).toISOString();
  const maxStart = new Date(Date.now() + 90 * 86400000).toISOString();

  let inserted = 0;
  let updated = 0;
  let eventsSeen = 0;

  let nextUrl: string | null =
    `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(conn.calendly_user_uri)}` +
    `&count=100&sort=start_time:asc&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}`;

  let pages = 0;
  while (nextUrl && pages < 6) {
    pages++;
    const evRes = await fetch(nextUrl, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!evRes.ok) {
      const txt = await evRes.text().catch(() => "");
      return json({ error: `Calendly list events failed (${evRes.status}): ${txt.slice(0, 200)}` }, { status: 502, headers: cors });
    }
    const evJson = await evRes.json();
    const events: any[] = evJson?.collection ?? [];

    for (const evt of events) {
      eventsSeen++;
      const externalEventUri = evt?.uri ?? null;
      if (!externalEventUri) continue;
      const uuid = String(externalEventUri).split("/").pop();
      const start = evt?.start_time ?? null;
      const end = evt?.end_time ?? null;
      const title = evt?.name ?? "Calendly Meeting";
      const location = evt?.location ?? null;
      const meetingUrl = meetingUrlFromLocation(location);
      const meetingType = typeof location?.type === "string" ? location.type : null;
      const status = String(evt?.status || "").toLowerCase() === "canceled" ? "canceled" : "scheduled";

      // Fetch invitees for this event (one meeting row per invitee, matching the webhook)
      let invitees: any[] = [];
      try {
        const invRes = await fetch(
          `https://api.calendly.com/scheduled_events/${uuid}/invitees?count=100`,
          { headers: { authorization: `Bearer ${accessToken}` } },
        );
        if (invRes.ok) {
          const invJson = await invRes.json();
          invitees = invJson?.collection ?? [];
        }
      } catch {
        invitees = [];
      }

      const rows = invitees.length ? invitees : [null];
      for (const invitee of rows) {
        const externalInviteeUri = invitee?.uri ?? null;

        let existing: any = null;
        if (externalInviteeUri) {
          const r = await supabaseAdmin
            .from("meetings").select("id").eq("external_invitee_uri", externalInviteeUri).maybeSingle();
          if (r.error) throw r.error;
          existing = r.data;
        }
        if (!existing && externalEventUri) {
          const r = await supabaseAdmin
            .from("meetings").select("id").eq("external_event_uri", externalEventUri).maybeSingle();
          if (r.error) throw r.error;
          existing = r.data;
        }

        const basePatch: Record<string, any> = {
          source: "calendly",
          external_provider: "calendly",
          external_event_uri: externalEventUri,
          external_invitee_uri: externalInviteeUri,
          advisor_id: uid,
          title,
          meeting_type: meetingType,
          meeting_url: meetingUrl,
          location,
          attendees: invitee ? { invitee } : null,
          status,
          last_synced_at: new Date().toISOString(),
        };
        if (start) basePatch.start_time = start;
        if (end) basePatch.end_time = end;

        if (existing?.id) {
          const { error: upErr } = await supabaseAdmin.from("meetings").update(basePatch).eq("id", existing.id);
          if (upErr) throw upErr;
          updated++;
        } else {
          const { error: insErr } = await supabaseAdmin.from("meetings").insert(basePatch);
          if (insErr) throw insErr;
          inserted++;
        }
      }
    }

    nextUrl = evJson?.pagination?.next_page ?? null;
  }

  return json({ ok: true, events: eventsSeen, inserted, updated }, { headers: cors });
});
