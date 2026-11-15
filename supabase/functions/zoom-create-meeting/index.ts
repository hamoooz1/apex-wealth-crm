import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";
import { ensureZoomAccessToken } from "../_shared/providerTokens.ts";
import { createZoomApiMeeting, deleteZoomApiMeeting, updateZoomApiMeeting, type ZoomMeetingResult } from "../_shared/zoomApi.ts";

type Admin = ReturnType<typeof createClient>;

function meetingResponse(zoom: ZoomMeetingResult) {
  return {
    ok: true,
    zoom_meeting_id: zoom.id,
    join_url: zoom.join_url,
    start_url: zoom.start_url,
    passcode: zoom.password,
    start_time: zoom.start_time,
    duration: zoom.duration,
    timezone: zoom.timezone,
    uuid: zoom.uuid,
  };
}

async function tokenForUser(admin: Admin, userId: string, clientId: string, clientSecret: string) {
  const conn = await admin
    .from("zoom_connections")
    .select("id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (conn.error) throw conn.error;
  if (!conn.data?.id) {
    return { error: "No active Zoom connection. Connect Zoom in Settings.", status: 409 as const };
  }
  try {
    const token = await ensureZoomAccessToken(admin, conn.data.id as string, clientId, clientSecret);
    if (!token.accessToken) {
      return { error: "Zoom needs to be reconnected in Settings.", status: 409 as const };
    }
    return { accessToken: token.accessToken };
  } catch (e) {
    return { error: (e as Error).message || "Zoom token refresh failed", status: 502 as const };
  }
}

async function pointCrmAtZoom(
  admin: Admin,
  meetingId: string,
  zoom: ZoomMeetingResult,
  previousId: string | null,
) {
  const existing = await admin
    .from("meetings")
    .select("id, source, external_provider, external_event_uri, location, field_origins, meeting_url")
    .eq("id", meetingId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data?.id) return;

  const row = existing.data as {
    source: string | null;
    external_provider: string | null;
    external_event_uri: string | null;
    location: Record<string, unknown> | null;
    field_origins: Record<string, string> | null;
  };
  const origins = { ...(row.field_origins || {}) };
  for (const key of ["zoom_meeting_id", "zoom_meeting_uuid", "meeting_url", "location"]) {
    if (origins[key] === "advisor") origins[key] = "provider";
  }
  const calendly = row.source === "calendly" || row.external_provider === "calendly";
  const location = {
    ...(row.location && typeof row.location === "object" ? row.location : {}),
    provider: "zoom",
    zoom_meeting_id: zoom.id,
    join_url: zoom.join_url,
    start_url: zoom.start_url,
    passcode: zoom.password,
  };
  const patch: Record<string, unknown> = {
    zoom_meeting_id: zoom.id,
    zoom_meeting_uuid: zoom.uuid,
    meeting_url: zoom.join_url,
    meeting_type: "zoom",
    location,
    field_origins: origins,
  };
  if (!calendly) {
    patch.external_provider = "zoom";
    patch.external_event_uri = `zoom:${zoom.id}`;
    if (!row.source || row.source === "manual") patch.source = "zoom";
  }
  if (previousId && previousId !== zoom.id) {
    const alias = await admin.from("meeting_external_aliases").upsert(
      {
        meeting_id: meetingId,
        provider: "zoom",
        kind: "zoom_meeting",
        external_id: previousId,
        superseded_at: new Date().toISOString(),
      },
      { onConflict: "provider,kind,external_id" },
    );
    if (alias.error && !/meeting_external_aliases|schema cache|does not exist/i.test(alias.error.message || "")) {
      throw alias.error;
    }
  }
  const saved = await admin.from("meetings").update(patch).eq("id", meetingId);
  if (saved.error) throw saved.error;
  const current = await admin.from("meeting_external_aliases").upsert(
    {
      meeting_id: meetingId,
      provider: "zoom",
      kind: "zoom_meeting",
      external_id: zoom.id,
    },
    { onConflict: "provider,kind,external_id" },
  );
  if (current.error && !/meeting_external_aliases|schema cache|does not exist/i.test(current.error.message || "")) {
    throw current.error;
  }
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

  let body: {
    action?: string;
    title?: string;
    start_time?: string;
    duration?: number;
    timezone?: string;
    zoom_meeting_id?: string;
    crm_meeting_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }

  const action = body.action || "create";
  if (!["create", "update", "delete", "regenerate"].includes(action)) {
    return json({ error: "action must be create, update, delete, or regenerate" }, { status: 400, headers: cors });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = await tokenForUser(admin, uid, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET);
  if ("error" in token) return json({ error: token.error }, { status: token.status, headers: cors });

  const previousId = body.zoom_meeting_id ? String(body.zoom_meeting_id) : "";
  if ((action === "update" || action === "delete") && !previousId) {
    return json({ error: "zoom_meeting_id is required" }, { status: 400, headers: cors });
  }

  if (action === "delete") {
    const removed = await deleteZoomApiMeeting(token.accessToken, previousId);
    return json({ ok: true, deleted: removed }, { headers: cors });
  }

  const title = (body.title || "Meeting").toString().slice(0, 200);
  const startTime = body.start_time;
  const duration = Math.max(5, Math.min(1440, Number(body.duration || 30)));
  const timezone = body.timezone || "UTC";
  if (!startTime || Number.isNaN(new Date(startTime).getTime())) {
    return json({ error: "Valid start_time (ISO 8601) is required" }, { status: 400, headers: cors });
  }
  const payload = { topic: title, start_time: startTime, duration, timezone };

  if (action === "update") {
    await updateZoomApiMeeting(token.accessToken, previousId, payload);
    return json({ ok: true, zoom_meeting_id: previousId, updated: true }, { headers: cors });
  }

  if (body.crm_meeting_id) {
    const visible = await supabaseAuthed.from("meetings").select("id").eq("id", body.crm_meeting_id).maybeSingle();
    if (visible.error) return json({ error: visible.error.message }, { status: 500, headers: cors });
    if (!visible.data?.id) return json({ error: "Meeting not found" }, { status: 404, headers: cors });
  }

  let created: ZoomMeetingResult;
  try {
    created = await createZoomApiMeeting(token.accessToken, payload);
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 502, headers: cors });
  }

  if (body.crm_meeting_id) {
    try {
      await pointCrmAtZoom(admin, body.crm_meeting_id, created, previousId || null);
    } catch (e) {
      await deleteZoomApiMeeting(token.accessToken, created.id).catch(() => "missing");
      return json({ error: (e as Error).message || "Could not attach the Zoom meeting" }, { status: 500, headers: cors });
    }
  }

  let previousDelete: "deleted" | "missing" | "skipped" | "failed" = "skipped";
  if ((action === "regenerate" || previousId) && previousId && previousId !== created.id) {
    try {
      previousDelete = await deleteZoomApiMeeting(token.accessToken, previousId);
    } catch (e) {
      console.warn("[zoom-create-meeting] old meeting was not deleted", (e as Error).message);
      previousDelete = "failed";
    }
  }

  return json({ ...meetingResponse(created), previous_delete: previousDelete }, { headers: cors });
});
