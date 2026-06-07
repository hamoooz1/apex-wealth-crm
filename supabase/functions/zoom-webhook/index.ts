import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers ?? {}) },
  });
}

async function hmacSha256Hex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEq(a: string, b: string) {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function pickRecordingFiles(files: any[]) {
  const out: { play_url: string | null; download_url: string | null; transcript_url: string | null } = {
    play_url: null,
    download_url: null,
    transcript_url: null,
  };
  for (const f of files || []) {
    const ft = String(f?.file_type || "").toUpperCase();
    if (ft === "TRANSCRIPT" || ft === "CC" || ft === "TIMELINE") {
      out.transcript_url = f?.download_url || f?.play_url || out.transcript_url;
    } else if (ft === "MP4" || ft === "M4A") {
      out.play_url = f?.play_url || out.play_url;
      out.download_url = f?.download_url || out.download_url;
    }
  }
  return out;
}

/** Prefer Zoom's unified summary_content, then legacy fields. */
function buildSummaryText(obj: any): string {
  if (obj?.summary_content) return String(obj.summary_content).trim();

  const parts: string[] = [];
  if (obj?.summary_title) parts.push(String(obj.summary_title));
  if (obj?.summary_overview) parts.push(String(obj.summary_overview));

  const details = Array.isArray(obj?.summary_details) ? obj.summary_details : [];
  for (const d of details) {
    if (d?.label && d?.summary) parts.push(`${d.label}: ${d.summary}`);
    else if (d?.summary) parts.push(String(d.summary));
  }

  const nextSteps = Array.isArray(obj?.next_steps) ? obj.next_steps : [];
  if (nextSteps.length) parts.push(`Next steps:\n- ${nextSteps.join("\n- ")}`);

  return parts.join("\n\n").trim();
}

const SUMMARY_EVENTS = new Set([
  "meeting.summary_completed",
  "meeting.aic_transcript_completed",
  "recording.transcript_completed",
]);

async function resolveMeeting(
  supabaseAdmin: ReturnType<typeof createClient>,
  zoomMeetingId: string,
  hostId: string | null,
) {
  let meetingRow: any = null;

  if (zoomMeetingId) {
    const r = await supabaseAdmin
      .from("meetings")
      .select("id, advisor_id, client_id, lead_id, title, notes")
      .eq("external_event_uri", `zoom:${zoomMeetingId}`)
      .maybeSingle();
    meetingRow = r.data || null;
  }

  let advisorId: string | null = meetingRow?.advisor_id ?? null;
  if (!advisorId && hostId) {
    const r = await supabaseAdmin
      .from("zoom_connections")
      .select("user_id")
      .eq("zoom_user_id", hostId)
      .is("revoked_at", null)
      .maybeSingle();
    advisorId = r.data?.user_id ?? null;
  }

  return { meetingRow, advisorId };
}

async function attachSummary(
  supabaseAdmin: ReturnType<typeof createClient>,
  opts: {
    zoomMeetingId: string;
    meetingRow: any;
    advisorId: string | null;
    summaryText: string;
    topic?: string | null;
  },
) {
  const { zoomMeetingId, meetingRow, advisorId, summaryText, topic } = opts;
  if (!summaryText) return;

  const existing = await supabaseAdmin
    .from("meeting_recordings")
    .select("id")
    .eq("provider", "zoom")
    .eq("external_meeting_id", zoomMeetingId)
    .maybeSingle();

  if (existing.data?.id) {
    await supabaseAdmin
      .from("meeting_recordings")
      .update({ summary: summaryText, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);
  } else {
    await supabaseAdmin.from("meeting_recordings").insert({
      provider: "zoom",
      external_meeting_id: zoomMeetingId,
      meeting_id: meetingRow?.id ?? null,
      client_id: meetingRow?.client_id ?? null,
      advisor_id: advisorId,
      topic: topic ?? meetingRow?.title ?? null,
      summary: summaryText,
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const meetingTitle = meetingRow?.title || topic || "Zoom meeting";

  if (meetingRow?.id) {
    const prefix = meetingRow.notes ? `${meetingRow.notes}\n\n` : "";
    const stamped = `--- AI summary (${stamp}) — ${meetingTitle} ---\n${summaryText}`;
    await supabaseAdmin.from("meetings").update({ notes: `${prefix}${stamped}` }).eq("id", meetingRow.id);
  }

  if (meetingRow?.client_id && advisorId) {
    const sourceRef = `zoom:summary:${zoomMeetingId}`;
    const noteBody = `--- Zoom AI summary (${stamp}) — ${meetingTitle} ---\n\n${summaryText}`;
    const { data: existingNote } = await supabaseAdmin
      .from("client_notes")
      .select("id")
      .eq("client_id", meetingRow.client_id)
      .eq("source_ref", sourceRef)
      .maybeSingle();

    if (existingNote?.id) {
      await supabaseAdmin
        .from("client_notes")
        .update({ body: noteBody, kind: "meeting", updated_at: new Date().toISOString() })
        .eq("id", existingNote.id);
    } else {
      await supabaseAdmin.from("client_notes").insert({
        client_id: meetingRow.client_id,
        author_id: advisorId,
        kind: "meeting",
        body: noteBody,
        source_ref: sourceRef,
      });
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ZOOM_WEBHOOK_SECRET_TOKEN = Deno.env.get("ZOOM_WEBHOOK_SECRET_TOKEN");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Missing Supabase env" }, { status: 500 });
  if (!ZOOM_WEBHOOK_SECRET_TOKEN) return json({ error: "Missing ZOOM_WEBHOOK_SECRET_TOKEN" }, { status: 500 });

  const rawBody = await req.text();
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = body?.event;

  if (event === "endpoint.url_validation") {
    const plainToken = body?.payload?.plainToken ?? "";
    const encryptedToken = await hmacSha256Hex(ZOOM_WEBHOOK_SECRET_TOKEN, plainToken);
    return json({ plainToken, encryptedToken });
  }

  const ts = req.headers.get("x-zm-request-timestamp") || "";
  const sigHeader = req.headers.get("x-zm-signature") || "";
  const message = `v0:${ts}:${rawBody}`;
  const expected = `v0=${await hmacSha256Hex(ZOOM_WEBHOOK_SECRET_TOKEN, message)}`;
  if (!sigHeader || !timingSafeEq(sigHeader, expected)) {
    return json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const obj = body?.payload?.object ?? {};
  const zoomMeetingId = String(obj?.id ?? obj?.meeting_id ?? "");
  const hostId = obj?.host_id ?? obj?.meeting_host_id ?? null;

  console.log("[zoom-webhook]", event, "meetingId=", zoomMeetingId || "n/a");

  const { meetingRow, advisorId } = await resolveMeeting(supabaseAdmin, zoomMeetingId, hostId);

  if (event === "meeting.started") {
    if (meetingRow?.id) {
      await supabaseAdmin.from("meetings").update({ last_synced_at: new Date().toISOString() }).eq("id", meetingRow.id);
    }
    return json({ ok: true });
  }

  if (event === "meeting.ended") {
    if (meetingRow?.id) {
      await supabaseAdmin
        .from("meetings")
        .update({ status: "completed", last_synced_at: new Date().toISOString() })
        .eq("id", meetingRow.id);

      if (meetingRow.client_id && advisorId) {
        const due = new Date();
        due.setDate(due.getDate() + 1);
        await supabaseAdmin.from("tasks").insert({
          title: `Send recap for: ${meetingRow.title || "meeting"}`,
          description: "Auto-created when the Zoom meeting ended.",
          status: "todo",
          priority: "medium",
          due_date: due.toISOString().slice(0, 10),
          assigned_to: advisorId,
          client_id: meetingRow.client_id,
          created_at: new Date().toISOString(),
        });
      }
    }
    return json({ ok: true });
  }

  if (event === "recording.completed") {
    const files = Array.isArray(obj?.recording_files) ? obj.recording_files : [];
    const picked = pickRecordingFiles(files);
    const firstStart = files[0]?.recording_start ?? obj?.start_time ?? null;
    const lastEnd = files[files.length - 1]?.recording_end ?? null;

    await supabaseAdmin.from("meeting_recordings").upsert(
      {
        provider: "zoom",
        external_meeting_id: zoomMeetingId || null,
        meeting_id: meetingRow?.id ?? null,
        client_id: meetingRow?.client_id ?? null,
        advisor_id: advisorId,
        topic: obj?.topic ?? meetingRow?.title ?? null,
        recording_start: firstStart,
        recording_end: lastEnd,
        duration_minutes: obj?.duration ?? null,
        play_url: obj?.share_url ?? picked.play_url,
        download_url: picked.download_url,
        transcript_url: picked.transcript_url,
        files,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider,external_meeting_id" },
    );
    return json({ ok: true });
  }

  if (SUMMARY_EVENTS.has(event)) {
    const summaryText = buildSummaryText(obj);
    if (zoomMeetingId && summaryText) {
      await attachSummary(supabaseAdmin, {
        zoomMeetingId,
        meetingRow,
        advisorId,
        summaryText,
        topic: obj?.summary_title ?? obj?.meeting_topic ?? obj?.topic ?? null,
      });
      console.log("[zoom-webhook] summary attached", zoomMeetingId, "client=", meetingRow?.client_id ?? "none");
    } else {
      console.log("[zoom-webhook] summary event without text or meeting id", event);
    }
    return json({ ok: true, had_summary: !!summaryText });
  }

  return json({ ok: true, ignored: event ?? null });
});
