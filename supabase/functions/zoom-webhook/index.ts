import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ensureZoomAccessToken } from "../_shared/providerTokens.ts";
import { notifyZoomDeauthorization } from "../_shared/zoomApi.ts";
import { zoomTimestampFresh } from "../_shared/meetingStatus.ts";
import { beginWebhookEvent, finishWebhookEvent, sha256Hex } from "../_shared/webhookEvents.ts";
import {
  MAX_MEDIA_BYTES,
  MAX_TRANSCRIPT_BYTES,
  recordingCopyDecision,
  summaryTextFromZoom,
  vttToText,
  zoomDeleteApplies,
  zoomIdsFromEvent,
  zoomRetentionAllowed,
} from "../_shared/zoomMeetings.ts";

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

type Admin = ReturnType<typeof createClient>;

const MEETING_COLUMNS =
  "id, advisor_id, client_id, lead_id, title, status_origin, zoom_meeting_id, zoom_meeting_uuid, field_origins";

type MeetingRow = {
  id: string;
  advisor_id: string | null;
  client_id: string | null;
  lead_id: string | null;
  title: string | null;
  status_origin: string | null;
  zoom_meeting_id: string | null;
  zoom_meeting_uuid: string | null;
  field_origins: Record<string, string> | null;
};

function missingColumn(message: string) {
  return /column|schema cache|does not exist/i.test(message);
}

async function findMeetings(admin: Admin, meetingId: string | null, uuid: string | null): Promise<MeetingRow[]> {
  const found = new Map<string, MeetingRow>();
  const add = (rows: MeetingRow[] | null | undefined) => {
    for (const row of rows || []) {
      if (row?.id) found.set(row.id, row);
    }
  };

  async function selectWhere(column: string, value: string) {
    const res = await admin.from("meetings").select(MEETING_COLUMNS).eq(column, value);
    if (res.error) {
      if (missingColumn(res.error.message || "")) {
        const plain = await admin
          .from("meetings")
          .select("id, advisor_id, client_id, lead_id, title")
          .eq(column === "zoom_meeting_id" ? "external_event_uri" : column, column === "zoom_meeting_id" ? `zoom:${value}` : value);
        if (plain.error && !missingColumn(plain.error.message || "")) throw plain.error;
        add((plain.data || []) as MeetingRow[]);
        return;
      }
      throw res.error;
    }
    add((res.data || []) as MeetingRow[]);
  }

  if (meetingId) {
    await selectWhere("zoom_meeting_id", meetingId);
    const byUri = await admin.from("meetings").select(MEETING_COLUMNS).eq("external_event_uri", `zoom:${meetingId}`);
    if (byUri.error) {
      if (!missingColumn(byUri.error.message || "")) throw byUri.error;
    } else {
      add((byUri.data || []) as MeetingRow[]);
    }
  }
  if (uuid) await selectWhere("zoom_meeting_uuid", uuid);

  const externalIds = [meetingId, uuid].filter((id): id is string => Boolean(id));
  if (externalIds.length) {
    const aliases = await admin
      .from("meeting_external_aliases")
      .select("meeting_id")
      .eq("provider", "zoom")
      .in("external_id", externalIds);
    if (aliases.error) {
      if (!missingColumn(aliases.error.message || "")) throw aliases.error;
    } else {
      const ids = [...new Set((aliases.data || []).map((row) => (row as { meeting_id?: string }).meeting_id).filter(Boolean))] as string[];
      if (ids.length) {
        const rows = await admin.from("meetings").select(MEETING_COLUMNS).in("id", ids);
        if (rows.error) {
          if (!missingColumn(rows.error.message || "")) throw rows.error;
        } else {
          add((rows.data || []) as MeetingRow[]);
        }
      }
    }
  }
  return [...found.values()];
}

async function rememberZoomAlias(admin: Admin, meetingId: string, zoomId: string) {
  const { error } = await admin.from("meeting_external_aliases").upsert(
    {
      meeting_id: meetingId,
      provider: "zoom",
      kind: "zoom_meeting",
      external_id: zoomId,
    },
    { onConflict: "provider,kind,external_id" },
  );
  if (error && !missingColumn(error.message || "")) throw error;
}

async function stampMeetings(admin: Admin, rows: MeetingRow[], patch: Record<string, unknown>) {
  if (!rows.length) return;
  const updated = await admin.from("meetings").update(patch).in("id", rows.map((row) => row.id));
  if (updated.error && !missingColumn(updated.error.message || "")) throw updated.error;
}

async function ensureRecapTask(admin: Admin, meeting: MeetingRow, advisorId: string) {
  if (!meeting.client_id) return;
  const sourceRef = `zoom:recap:${meeting.id}`;
  const due = new Date();
  due.setDate(due.getDate() + 1);
  const row: Record<string, unknown> = {
    title: `Send recap for: ${meeting.title || "meeting"}`,
    description: "Auto-created when the Zoom meeting ended.",
    status: "todo",
    priority: "medium",
    due_date: due.toISOString().slice(0, 10),
    assigned_to: advisorId,
    client_id: meeting.client_id,
    created_at: new Date().toISOString(),
    source_ref: sourceRef,
  };
  const inserted = await admin.from("tasks").insert(row);
  if (!inserted.error || inserted.error.code === "23505") return;
  if (!/source_ref/.test(inserted.error.message || "")) throw inserted.error;
  const { source_ref: _source, ...rest } = row;
  const retry = await admin.from("tasks").insert(rest);
  if (retry.error) throw retry.error;
}

async function accessTokenForAdvisor(admin: Admin, advisorId: string | null): Promise<string | null> {
  if (!advisorId) return null;
  const clientId = Deno.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Deno.env.get("ZOOM_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const conn = await admin
    .from("zoom_connections")
    .select("id")
    .eq("user_id", advisorId)
    .is("revoked_at", null)
    .maybeSingle();
  if (conn.error || !conn.data?.id) return null;
  try {
    const token = await ensureZoomAccessToken(admin, conn.data.id as string, clientId, clientSecret);
    return token.accessToken;
  } catch (e) {
    console.warn("[zoom-webhook] token unavailable", (e as Error).message);
    return null;
  }
}

async function downloadZoomFile(url: string, token: string, cap: number): Promise<{ bytes: Uint8Array } | { skipped: string }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return { skipped: `download_${res.status}` };
  const len = Number(res.headers.get("content-length") || 0);
  if (len > cap) return { skipped: "too_large" };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > cap) return { skipped: "too_large" };
  return { bytes };
}

async function storeBytes(admin: Admin, path: string, bytes: Uint8Array, contentType: string): Promise<string | null> {
  const upload = await admin.storage.from("meeting-recordings").upload(path, bytes, {
    upsert: true,
    contentType,
  });
  if (upload.error) {
    console.warn("[zoom-webhook] storage upload skipped", upload.error.message);
    return upload.error.message;
  }
  return null;
}

function fileExt(file: Record<string, unknown>, fallback: string) {
  const ext = typeof file.file_extension === "string" ? file.file_extension.replace(/^\./, "") : "";
  return (ext || fallback).toLowerCase();
}

async function upsertRecording(
  admin: Admin,
  row: Record<string, unknown>,
) {
  const saved = await admin.from("meeting_recordings").upsert(row, { onConflict: "provider,external_meeting_id" });
  if (saved.error) throw saved.error;
}

async function handleDeauthorization(admin: Admin, payload: Record<string, unknown>) {
  const zoomUserId = typeof payload.user_id === "string" ? payload.user_id : "";
  if (!zoomUserId) return;
  const conns = await admin
    .from("zoom_connections")
    .select("id, user_id")
    .eq("zoom_user_id", zoomUserId);
  if (conns.error) throw conns.error;
  const rows = (conns.data || []) as { id: string; user_id: string }[];
  const now = new Date().toISOString();
  for (const conn of rows) {
    const marked = await admin
      .from("zoom_connections")
      .update({
        status: "deauthorized",
        revoked_at: now,
        token_status: "revoked",
        token_status_at: now,
        last_sync_error: "Zoom app was removed. Reconnect Zoom in Settings.",
        token_expires_at: null,
      })
      .eq("id", conn.id);
    if (marked.error) throw marked.error;
    await admin.from("zoom_connection_tokens").delete().eq("connection_id", conn.id);
  }

  if (!zoomRetentionAllowed(payload)) {
    const advisorIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
    for (const advisorId of advisorIds) {
      const recs = await admin
        .from("meeting_recordings")
        .select("id, storage_path, transcript_storage_path")
        .eq("advisor_id", advisorId)
        .eq("provider", "zoom");
      if (recs.error && !missingColumn(recs.error.message || "")) throw recs.error;
      const paths = (recs.data || []).flatMap((rec) => {
        const row = rec as { storage_path?: string | null; transcript_storage_path?: string | null };
        return [row.storage_path, row.transcript_storage_path].filter((path): path is string => Boolean(path));
      });
      if (paths.length) {
        const removed = await admin.storage.from("meeting-recordings").remove(paths);
        if (removed.error) console.warn("[zoom-webhook] storage purge skipped", removed.error.message);
      }
      if (!recs.error) {
        const deleted = await admin.from("meeting_recordings").delete().eq("advisor_id", advisorId).eq("provider", "zoom");
        if (deleted.error) throw deleted.error;
      }
      const cleared = await admin
        .from("meetings")
        .update({ provider_summary: null })
        .eq("advisor_id", advisorId)
        .not("zoom_meeting_id", "is", null);
      if (cleared.error && !missingColumn(cleared.error.message || "")) throw cleared.error;
    }
  }

  const clientId = Deno.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Deno.env.get("ZOOM_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("Zoom client env is missing; deauthorization was stored but compliance was not sent");
  }
  await notifyZoomDeauthorization({ clientId, clientSecret, payload });
}

const SUMMARY_EVENTS = new Set([
  "meeting.summary_completed",
  "meeting.aic_transcript_completed",
  "recording.transcript_completed",
]);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ZOOM_WEBHOOK_SECRET_TOKEN = Deno.env.get("ZOOM_WEBHOOK_SECRET_TOKEN");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Missing Supabase env" }, { status: 500 });
  if (!ZOOM_WEBHOOK_SECRET_TOKEN) return json({ error: "Missing ZOOM_WEBHOOK_SECRET_TOKEN" }, { status: 500 });

  const rawBody = await req.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = typeof body.event === "string" ? body.event : "";

  if (event === "endpoint.url_validation") {
    const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {};
    const plainToken = typeof payload.plainToken === "string" ? payload.plainToken : "";
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

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const eventKey = await sha256Hex(rawBody);
  const claim = await beginWebhookEvent(admin, "zoom", eventKey, event || null);
  if (claim === "duplicate") return json({ ok: true, duplicate: true });
  const finish = (status: "processed" | "error", error?: string) =>
    finishWebhookEvent(admin, "zoom", eventKey, { status, error });

  try {
    const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {};

    if (event === "app_deauthorized") {
      await handleDeauthorization(admin, payload);
      await finish("processed");
      return json({ ok: true, deauthorized: true });
    }

    const obj = payload.object && typeof payload.object === "object" ? payload.object as Record<string, unknown> : {};
    const ids = zoomIdsFromEvent(obj);
    const hostId = (typeof obj.host_id === "string" && obj.host_id) ||
      (typeof obj.meeting_host_id === "string" && obj.meeting_host_id) ||
      null;
    const meetings = await findMeetings(admin, ids.meetingId, ids.uuid);
    const advisorId = meetings.find((row) => row.advisor_id)?.advisor_id ?? null;
    let resolvedAdvisor = advisorId;
    if (!resolvedAdvisor && hostId) {
      const host = await admin
        .from("zoom_connections")
        .select("user_id")
        .eq("zoom_user_id", hostId)
        .is("revoked_at", null)
        .maybeSingle();
      resolvedAdvisor = (host.data?.user_id as string | undefined) ?? null;
    }

    if (resolvedAdvisor) {
      const marked = await admin
        .from("zoom_connections")
        .update({ last_webhook_at: new Date().toISOString() })
        .eq("user_id", resolvedAdvisor)
        .is("revoked_at", null);
      if (marked.error && !missingColumn(marked.error.message || "")) {
        console.warn("[zoom-webhook] last_webhook_at skipped", marked.error.message);
      }
    }

    if (ids.uuid) {
      const needUuid = meetings.filter((row) => !row.zoom_meeting_uuid);
      if (needUuid.length) await stampMeetings(admin, needUuid, { zoom_meeting_uuid: ids.uuid });
    }
    if (ids.meetingId) {
      const needId = meetings.filter((row) => !row.zoom_meeting_id);
      if (needId.length) {
        await stampMeetings(admin, needId, { zoom_meeting_id: ids.meetingId });
        for (const row of needId) await rememberZoomAlias(admin, row.id, ids.meetingId);
      }
    }

    if (event === "meeting.started") {
      await stampMeetings(admin, meetings, { last_synced_at: new Date().toISOString() });
      await finish("processed");
      return json({ ok: true, meetings: meetings.length });
    }

    if (event === "meeting.ended") {
      const locked = meetings.filter((row) => row.status_origin === "advisor");
      const open = meetings.filter((row) => row.status_origin !== "advisor");
      await stampMeetings(admin, locked, { last_synced_at: new Date().toISOString() });
      await stampMeetings(admin, open, {
        last_synced_at: new Date().toISOString(),
        status: "completed",
        status_origin: "provider",
      });
      if (resolvedAdvisor) {
        for (const meeting of meetings) await ensureRecapTask(admin, meeting, resolvedAdvisor);
      }
      await finish("processed");
      return json({ ok: true, meetings: meetings.length });
    }

    if (event === "meeting.deleted") {
      const deletedId = ids.meetingId || "";
      const current = meetings.filter((row) => zoomDeleteApplies(row.zoom_meeting_id, deletedId));
      const open = current.filter((row) => row.status_origin !== "advisor");
      await stampMeetings(admin, open, {
        status: "canceled",
        status_origin: "provider",
        last_synced_at: new Date().toISOString(),
      });
      await finish("processed");
      return json({ ok: true, canceled: open.length, ignored: meetings.length - current.length });
    }

    if (event === "recording.completed" || event === "recording.transcript_completed") {
      const files = Array.isArray(obj.recording_files) ? obj.recording_files as Record<string, unknown>[] : [];
      const token = await accessTokenForAdvisor(admin, resolvedAdvisor);
      let transcriptText = "";
      let storagePath: string | null = null;
      let transcriptPath: string | null = null;
      let storageError: string | null = token ? null : "no_zoom_token";
      const storedFiles: Record<string, unknown>[] = [];
      const primary = meetings.length === 1 ? meetings[0] : null;
      const zoomId = ids.meetingId || "unknown";

      for (const file of files) {
        const decision = recordingCopyDecision(file);
        const downloadUrl = typeof file.download_url === "string" ? file.download_url : "";
        if (!decision.copy || !downloadUrl) {
          storedFiles.push({ id: file.id ?? null, file_type: file.file_type ?? null, skipped: decision.reason || "no_download_url" });
          continue;
        }
        if (!token) {
          storedFiles.push({ id: file.id ?? null, file_type: file.file_type ?? null, skipped: "no_zoom_token" });
          continue;
        }
        const cap = decision.kind === "transcript" ? MAX_TRANSCRIPT_BYTES : MAX_MEDIA_BYTES;
        const downloaded = await downloadZoomFile(downloadUrl, token, cap);
        if ("skipped" in downloaded) {
          storedFiles.push({ id: file.id ?? null, file_type: file.file_type ?? null, skipped: downloaded.skipped });
          if (!storageError) storageError = downloaded.skipped;
          continue;
        }
        const ext = fileExt(file, decision.kind === "transcript" ? "vtt" : "mp4");
        const path = `${resolvedAdvisor || "unknown"}/${zoomId}/${String(file.id || file.file_type)}.${ext}`;
        const uploadError = await storeBytes(
          admin,
          path,
          downloaded.bytes,
          decision.kind === "transcript" ? "text/vtt" : ext === "m4a" ? "audio/mp4" : "video/mp4",
        );
        if (uploadError) {
          storageError = uploadError;
          storedFiles.push({ id: file.id ?? null, file_type: file.file_type ?? null, skipped: "upload_failed" });
          continue;
        }
        if (decision.kind === "transcript") {
          transcriptPath = path;
          const text = vttToText(new TextDecoder().decode(downloaded.bytes));
          if (text) transcriptText = transcriptText ? `${transcriptText}\n\n${text}` : text;
        } else if (!storagePath) {
          storagePath = path;
        }
        storedFiles.push({ id: file.id ?? null, file_type: file.file_type ?? null, storage_path: path, bytes: downloaded.bytes.byteLength });
      }

      const shareUrl = typeof obj.share_url === "string" ? obj.share_url : null;
      const passcode = typeof obj.password === "string"
        ? obj.password
        : typeof obj.recording_play_passcode === "string"
        ? obj.recording_play_passcode
        : null;
      if (ids.meetingId) {
        const recording: Record<string, unknown> = {
          provider: "zoom",
          external_meeting_id: ids.meetingId,
          advisor_id: resolvedAdvisor,
          topic: (typeof obj.topic === "string" && obj.topic) || primary?.title || null,
          recording_start: (files[0]?.recording_start as string | undefined) ?? (obj.start_time as string | undefined) ?? null,
          recording_end: (files[files.length - 1]?.recording_end as string | undefined) ?? null,
          duration_minutes: typeof obj.duration === "number" ? obj.duration : null,
          play_url: shareUrl,
          share_url: shareUrl,
          zoom_uuid: ids.uuid,
          files,
          stored_files: storedFiles,
          updated_at: new Date().toISOString(),
        };
        // Omit empty copies so a later transcript event does not wipe a stored video.
        if (primary) {
          recording.meeting_id = primary.id;
          recording.client_id = primary.client_id;
          recording.lead_id = primary.lead_id;
        }
        if (transcriptText) recording.transcript_text = transcriptText;
        if (storagePath) recording.storage_path = storagePath;
        if (transcriptPath) recording.transcript_storage_path = transcriptPath;
        if (storageError) recording.storage_error = storageError;
        if (passcode) recording.recording_passcode = passcode;
        await upsertRecording(admin, recording);
      }
      await finish("processed");
      return json({ ok: true, stored: storedFiles.filter((file) => file.storage_path).length, meetings: meetings.length });
    }

    if (SUMMARY_EVENTS.has(event)) {
      const summaryText = summaryTextFromZoom(obj);
      if (ids.meetingId && summaryText) {
        const primary = meetings.length === 1 ? meetings[0] : null;
        const existing = await admin
          .from("meeting_recordings")
          .select("id")
          .eq("provider", "zoom")
          .eq("external_meeting_id", ids.meetingId)
          .maybeSingle();
        if (existing.data?.id) {
          await admin.from("meeting_recordings").update({
            summary: summaryText,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.data.id);
        } else {
          const created: Record<string, unknown> = {
            provider: "zoom",
            external_meeting_id: ids.meetingId,
            advisor_id: resolvedAdvisor,
            topic: (typeof obj.meeting_topic === "string" && obj.meeting_topic) || primary?.title || null,
            summary: summaryText,
            zoom_uuid: ids.uuid,
          };
          if (primary) {
            created.meeting_id = primary.id;
            created.client_id = primary.client_id;
            created.lead_id = primary.lead_id;
          }
          await upsertRecording(admin, created);
        }
        if (meetings.length) {
          await stampMeetings(admin, meetings, { provider_summary: summaryText });
        }
      }
      await finish("processed");
      return json({ ok: true, had_summary: !!summaryText });
    }

    await finish("processed");
    return json({ ok: true, ignored: event || null });
  } catch (e) {
    const message = (e as Error).message || "Webhook failed";
    await finish("error", message);
    return json({ error: message }, { status: 500 });
  }
});
