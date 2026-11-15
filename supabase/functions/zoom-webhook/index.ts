import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zoomTimestampFresh } from "../_shared/meetingStatus.ts";
import { beginWebhookEvent, finishWebhookEvent, sha256Hex } from "../_shared/webhookEvents.ts";

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
    const withOrigin = await supabaseAdmin
      .from("meetings")
      .select("id, advisor_id, client_id, lead_id, title, notes, status_origin")
      .eq("external_event_uri", `zoom:${zoomMeetingId}`)
      .maybeSingle();
    if (!withOrigin.error) {
      meetingRow = withOrigin.data || null;
    } else if (/status_origin/.test(withOrigin.error.message || "")) {
      const plain = await supabaseAdmin
        .from("meetings")
        .select("id, advisor_id, client_id, lead_id, title, notes")
        .eq("external_event_uri", `zoom:${zoomMeetingId}`)
        .maybeSingle();
      if (plain.error) throw plain.error;
      meetingRow = plain.data || null;
    } else {
      throw withOrigin.error;
    }
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
}

async function ensureRecapTask(
  supabaseAdmin: ReturnType<typeof createClient>,
  meetingRow: { id: string; title?: string | null; client_id: string },
  advisorId: string,
) {
  const sourceRef = `zoom:recap:${meetingRow.id}`;
  const due = new Date();
  due.setDate(due.getDate() + 1);
  const row: Record<string, unknown> = {
    title: `Send recap for: ${meetingRow.title || "meeting"}`,
    description: "Auto-created when the Zoom meeting ended.",
    status: "todo",
    priority: "medium",
    due_date: due.toISOString().slice(0, 10),
    assigned_to: advisorId,
    client_id: meetingRow.client_id,
    created_at: new Date().toISOString(),
    source_ref: sourceRef,
  };
  const inserted = await supabaseAdmin.from("tasks").insert(row);
  if (!inserted.error || inserted.error.code === "23505") return;
  if (!/source_ref/.test(inserted.error.message || "")) throw inserted.error;

  const existing = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("client_id", meetingRow.client_id)
    .eq("title", row.title)
    .eq("description", row.description)
    .limit(1);
  if (existing.error) throw existing.error;
  if (existing.data && existing.data.length > 0) return;
  const { source_ref: _source, ...rest } = row;
  const retry = await supabaseAdmin.from("tasks").insert(rest);
  if (retry.error) throw retry.error;
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
  if (!zoomTimestampFresh(ts, Math.floor(Date.now() / 1000))) {
    return json({ error: "Stale webhook timestamp" }, { status: 401 });
  }
  const sigHeader = req.headers.get("x-zm-signature") || "";
  const message = `v0:${ts}:${rawBody}`;
  const expected = `v0=${await hmacSha256Hex(ZOOM_WEBHOOK_SECRET_TOKEN, message)}`;
  if (!sigHeader || !timingSafeEq(sigHeader, expected)) {
    return json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const eventKey = await sha256Hex(rawBody);
  const claim = await beginWebhookEvent(supabaseAdmin, "zoom", eventKey, typeof event === "string" ? event : null);
  if (claim === "duplicate") return json({ ok: true, duplicate: true });

  const finish = (status: "processed" | "error", error?: string) =>
    finishWebhookEvent(supabaseAdmin, "zoom", eventKey, { status, error });

  try {
  const obj = body?.payload?.object ?? {};
  const zoomMeetingId = String(obj?.id ?? obj?.meeting_id ?? "");
  const hostId = obj?.host_id ?? obj?.meeting_host_id ?? null;

  console.log("[zoom-webhook]", event, "meetingId=", zoomMeetingId || "n/a");

  const { meetingRow, advisorId } = await resolveMeeting(supabaseAdmin, zoomMeetingId, hostId);

  if (advisorId) {
    const marked = await supabaseAdmin
      .from("zoom_connections")
      .update({ last_webhook_at: new Date().toISOString() })
      .eq("user_id", advisorId)
      .is("revoked_at", null);
    if (marked.error && !/last_webhook_at/.test(marked.error.message || "")) {
      console.warn("[zoom-webhook] last_webhook_at skipped", marked.error.message);
    }
  }

  if (event === "meeting.started") {
    if (meetingRow?.id) {
      await supabaseAdmin.from("meetings").update({ last_synced_at: new Date().toISOString() }).eq("id", meetingRow.id);
    }
    await finish("processed");
    return json({ ok: true });
  }

  if (event === "meeting.ended") {
    if (meetingRow?.id) {
      const patch: Record<string, unknown> = { last_synced_at: new Date().toISOString() };
      if (meetingRow.status_origin !== "advisor") {
        patch.status = "completed";
        patch.status_origin = "provider";
      }
      const updated = await supabaseAdmin.from("meetings").update(patch).eq("id", meetingRow.id);
      if (updated.error && /status_origin/.test(updated.error.message || "")) {
        const { status_origin: _origin, ...rest } = patch;
        const retry = await supabaseAdmin.from("meetings").update(rest).eq("id", meetingRow.id);
        if (retry.error) throw retry.error;
      } else if (updated.error) {
        throw updated.error;
      }

      if (meetingRow.client_id && advisorId) {
        await ensureRecapTask(supabaseAdmin, meetingRow, advisorId);
      }
    }
    await finish("processed");
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
    await finish("processed");
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
    await finish("processed");
    return json({ ok: true, had_summary: !!summaryText });
  }

  await finish("processed");
  return json({ ok: true, ignored: event ?? null });
  } catch (e) {
    const message = (e as Error).message || "Webhook failed";
    await finish("error", message);
    return json({ error: message }, { status: 500 });
  }
});
