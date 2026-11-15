import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";
import { ensureCalendlyAccessToken, ensureZoomAccessToken } from "../_shared/providerTokens.ts";
import { deleteZoomApiMeeting, updateZoomApiMeeting } from "../_shared/zoomApi.ts";
import {
  calendlyCancelIsAlreadyGone,
  calendlyEventUuid,
  planProviderWriteback,
} from "../_shared/writeback.ts";

type Admin = ReturnType<typeof createClient>;

const MEETING_COLUMNS =
  "id, advisor_id, title, start_time, end_time, status, notes, client_id, lead_id, source, external_provider, external_event_uri, zoom_meeting_id, meeting_url";

function durationMinutes(start: string | null, end: string | null) {
  if (!start || !end) return 30;
  const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return 30;
  return Math.max(5, Math.min(1440, minutes));
}

async function cancelCalendly(admin: Admin, advisorId: string, eventUri: string) {
  const clientId = Deno.env.get("CALENDLY_CLIENT_ID");
  const clientSecret = Deno.env.get("CALENDLY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return "Calendly client env is not configured.";
  const uuid = calendlyEventUuid(eventUri);
  if (!uuid) return "This meeting has no Calendly event id to cancel.";
  const conn = await admin
    .from("calendly_connections")
    .select("id")
    .eq("user_id", advisorId)
    .is("revoked_at", null)
    .maybeSingle();
  if (conn.error) return conn.error.message;
  if (!conn.data?.id) return "No active Calendly connection for this advisor.";
  let token: string;
  try {
    token = await ensureCalendlyAccessToken(admin, conn.data.id as string, clientId, clientSecret);
  } catch (e) {
    return (e as Error).message;
  }
  const res = await fetch(`https://api.calendly.com/scheduled_events/${uuid}/cancellation`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: "Canceled in Apex Wealth CRM" }),
  });
  if (res.ok || res.status === 201) return null;
  const body = await res.text().catch(() => "");
  if (calendlyCancelIsAlreadyGone(res.status, body)) return null;
  return `Calendly did not cancel the booking (${res.status}). ${body.slice(0, 180)}`.trim();
}

async function zoomToken(admin: Admin, advisorId: string) {
  const clientId = Deno.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Deno.env.get("ZOOM_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { error: "Zoom client env is not configured." };
  const conn = await admin
    .from("zoom_connections")
    .select("id")
    .eq("user_id", advisorId)
    .is("revoked_at", null)
    .maybeSingle();
  if (conn.error) return { error: conn.error.message };
  if (!conn.data?.id) return { error: "No active Zoom connection for this advisor. Reconnect Zoom in Settings." };
  try {
    const token = await ensureZoomAccessToken(admin, conn.data.id as string, clientId, clientSecret);
    if (!token.accessToken) return { error: "Zoom needs to be reconnected in Settings." };
    return { accessToken: token.accessToken };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function pushZoom(admin: Admin, advisorId: string, zoomId: string, action: "delete" | "patch", after: { title: string; start_time: string; end_time: string | null }) {
  const token = await zoomToken(admin, advisorId);
  if ("error" in token) return token.error;
  try {
    if (action === "delete") {
      await deleteZoomApiMeeting(token.accessToken, zoomId);
      return null;
    }
    await updateZoomApiMeeting(token.accessToken, zoomId, {
      topic: after.title || "Meeting",
      start_time: after.start_time,
      duration: durationMinutes(after.start_time, after.end_time),
      timezone: "UTC",
    });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405, headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing Supabase env" }, { status: 500, headers: cors });
  }

  const authHeader = req.headers.get("authorization") || "";
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userRes, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userRes?.user?.id) return json({ error: "Unauthorized" }, { status: 401, headers: cors });

  let body: { meeting_id?: string; action?: string; patch?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }
  if (!body.meeting_id) return json({ error: "meeting_id is required" }, { status: 400, headers: cors });
  const action = body.action === "delete" ? "delete" : "save";

  const loaded = await userClient.from("meetings").select(MEETING_COLUMNS).eq("id", body.meeting_id).maybeSingle();
  if (loaded.error) return json({ error: loaded.error.message }, { status: 500, headers: cors });
  if (!loaded.data?.id) return json({ error: "Meeting not found" }, { status: 404, headers: cors });
  const current = loaded.data as Record<string, string | null>;

  const patch = body.patch || {};
  const after = {
    title: typeof patch.title === "string" ? patch.title : current.title,
    start_time: typeof patch.start_time === "string" ? patch.start_time : current.start_time,
    end_time: typeof patch.end_time === "string" ? patch.end_time : current.end_time,
    status: typeof patch.status === "string" ? patch.status : current.status,
  };
  const plan = planProviderWriteback({
    action,
    source: current.source,
    externalProvider: current.external_provider,
    zoomMeetingId: current.zoom_meeting_id,
    calendlyEventUri: current.external_event_uri,
    before: current,
    after,
  });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (action === "delete" && plan.calendly === "cancel") {
    const failure = await cancelCalendly(admin, current.advisor_id || "", current.external_event_uri || "");
    if (failure) {
      await admin.from("meetings").update({
        last_writeback_at: new Date().toISOString(),
        last_writeback_error: failure.slice(0, 300),
      }).eq("id", current.id);
      return json({
        error: `${failure} The CRM meeting was kept so Calendly does not create it again on the next sync.`,
      }, { status: 409, headers: cors });
    }
  }

  if (action === "delete" && plan.zoom === "delete" && current.zoom_meeting_id) {
    const failure = await pushZoom(admin, current.advisor_id || "", current.zoom_meeting_id, "delete", {
      title: after.title || "Meeting",
      start_time: after.start_time || new Date().toISOString(),
      end_time: after.end_time,
    });
    if (failure) {
      return json({ error: failure }, { status: 502, headers: cors });
    }
  }

  if (action === "delete") {
    const removed = await userClient.from("meetings").delete().eq("id", current.id);
    if (removed.error) return json({ error: removed.error.message }, { status: 500, headers: cors });
    return json({ ok: true, deleted: true }, { headers: cors });
  }

  const allowed = ["title", "start_time", "end_time", "status", "notes", "client_id", "lead_id", "meeting_type", "meeting_url", "advisor_id", "location", "zoom_meeting_id", "zoom_meeting_uuid"];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) update[key] = patch[key];
  }
  const saved = await userClient.from("meetings").update(update).eq("id", current.id).select("id").maybeSingle();
  if (saved.error) return json({ error: saved.error.message }, { status: 500, headers: cors });

  const failures: string[] = [];
  if (plan.calendly === "cancel") {
    const failure = await cancelCalendly(admin, current.advisor_id || "", current.external_event_uri || "");
    if (failure) failures.push(failure);
  }
  if (plan.zoom && current.zoom_meeting_id) {
    const failure = await pushZoom(admin, current.advisor_id || "", current.zoom_meeting_id, plan.zoom, {
      title: after.title || "Meeting",
      start_time: after.start_time || new Date().toISOString(),
      end_time: after.end_time,
    });
    if (failure) failures.push(failure);
  }

  await admin.from("meetings").update({
    last_writeback_at: new Date().toISOString(),
    last_writeback_error: failures.length ? failures.join(" ").slice(0, 300) : null,
    last_writeback_note: plan.calendlyTimeNote,
  }).eq("id", current.id);

  return json({
    ok: true,
    warning: failures[0] || plan.calendlyTimeNote || null,
  }, { headers: cors });
});
