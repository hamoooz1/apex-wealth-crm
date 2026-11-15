// Pure Zoom id, recording, and deauthorization rules. No I/O.

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

const ZOOM_ID = "([0-9]{9,13})";

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

/** Numeric Zoom meeting id from a join URL, a zoom: URI, or confno=. */
export function extractZoomMeetingIdFromText(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  if (/^[0-9]{9,13}$/.test(value)) return value;
  const patterns = [
    new RegExp(`zoom\\.us/${ZOOM_ID}(?:\\D|$)`, "i"),
    new RegExp(`zoom\\.us/(?:j|s|w|wc/join)/${ZOOM_ID}`, "i"),
    new RegExp(`(?:^|[?&])confno=${ZOOM_ID}`, "i"),
    new RegExp(`(?:^|\\b)zoom:${ZOOM_ID}\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export type ZoomLocationFields = {
  zoomMeetingId: string | null;
  uuid: string | null;
  joinUrl: string | null;
  passcode: string | null;
};

function joinUrlFrom(value: unknown): string | null {
  const direct = text(value);
  if (direct && /zoom\.us/i.test(direct)) return direct;
  return null;
}

/**
 * Calendly puts the Zoom id on location.data.id when the conference is pushed,
 * and always puts a join URL on location.join_url. Either one is enough.
 */
export function zoomFieldsFromLocation(location: unknown, meetingUrl?: unknown, externalEventUri?: unknown): ZoomLocationFields {
  const loc = location && typeof location === "object" ? location as Record<string, unknown> : null;
  const data = loc?.data && typeof loc.data === "object" ? loc.data as Record<string, unknown> : null;
  const joinUrl =
    joinUrlFrom(loc?.join_url) ||
    joinUrlFrom(data?.join_url) ||
    joinUrlFrom(loc?.location) ||
    joinUrlFrom(meetingUrl);
  const fromData = text(data?.id);
  const zoomMeetingId =
    (fromData && /^[0-9]{9,13}$/.test(fromData) ? fromData : null) ||
    extractZoomMeetingIdFromText(joinUrl) ||
    extractZoomMeetingIdFromText(loc?.location) ||
    extractZoomMeetingIdFromText(meetingUrl) ||
    extractZoomMeetingIdFromText(externalEventUri);
  const passcode =
    text(data?.password) ||
    text(data?.passcode) ||
    text(loc?.passcode) ||
    text(loc?.password) ||
    null;
  const uuid = text(data?.uuid) || text(loc?.uuid);
  return { zoomMeetingId, uuid, joinUrl, passcode };
}

/** Zoom path segment. UUIDs that contain / must be double-encoded. */
export function zoomPathId(id: string): string {
  if (id.includes("/") || id.startsWith("+")) return encodeURIComponent(encodeURIComponent(id));
  return encodeURIComponent(id);
}

export type RecordingKind = "transcript" | "media" | "skip";

export function recordingKind(fileType: unknown): RecordingKind {
  const ft = String(fileType || "").toUpperCase();
  if (ft === "TRANSCRIPT" || ft === "CC" || ft === "VTT") return "transcript";
  if (ft === "MP4" || ft === "M4A") return "media";
  return "skip";
}

export function recordingCopyDecision(file: { file_type?: unknown; file_size?: unknown }): {
  kind: RecordingKind;
  copy: boolean;
  reason: string | null;
} {
  const kind = recordingKind(file.file_type);
  if (kind === "skip") return { kind, copy: false, reason: "unused_file_type" };
  const size = Number(file.file_size || 0);
  const cap = kind === "transcript" ? MAX_TRANSCRIPT_BYTES : MAX_MEDIA_BYTES;
  if (Number.isFinite(size) && size > cap) return { kind, copy: false, reason: "too_large" };
  return { kind, copy: true, reason: null };
}

/** Drop cue timestamps so the CRM can show the transcript without a Zoom token. */
export function vttToText(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (/^WEBVTT/i.test(trimmed)) continue;
    if (/^NOTE(?:\s|$)/i.test(trimmed)) continue;
    if (/^STYLE(?:\s|$)/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(trimmed)) continue;
    if (/^Kind:|^Language:/i.test(trimmed)) continue;
    kept.push(trimmed);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function summaryTextFromZoom(obj: Record<string, unknown> | null | undefined): string {
  if (!obj) return "";
  if (typeof obj.summary_content === "string" && obj.summary_content.trim()) return obj.summary_content.trim();
  const parts: string[] = [];
  if (typeof obj.summary_title === "string" && obj.summary_title.trim()) parts.push(obj.summary_title.trim());
  if (typeof obj.summary_overview === "string" && obj.summary_overview.trim()) parts.push(obj.summary_overview.trim());
  const details = Array.isArray(obj.summary_details) ? obj.summary_details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const row = detail as Record<string, unknown>;
    if (typeof row.summary !== "string" || !row.summary.trim()) continue;
    parts.push(row.label ? `${row.label}: ${row.summary.trim()}` : row.summary.trim());
  }
  const nextSteps = Array.isArray(obj.next_steps) ? obj.next_steps.map((step) => String(step)).filter(Boolean) : [];
  if (nextSteps.length) parts.push(`Next steps:\n- ${nextSteps.join("\n- ")}`);
  return parts.join("\n\n").trim();
}

/** Zoom sends user_data_retention as the string "true" or "false". */
export function zoomRetentionAllowed(payload: Record<string, unknown> | null | undefined): boolean {
  const value = payload?.user_data_retention;
  return value === true || value === "true";
}

export function zoomIdsFromEvent(obj: Record<string, unknown> | null | undefined): { meetingId: string | null; uuid: string | null } {
  if (!obj) return { meetingId: null, uuid: null };
  const meetingId =
    extractZoomMeetingIdFromText(obj.id) ||
    extractZoomMeetingIdFromText(obj.meeting_id) ||
    null;
  const uuid = text(obj.uuid) || text(obj.meeting_uuid);
  return { meetingId, uuid };
}

/**
 * A deleted Zoom id that is only an old alias (regenerate replaced it) must
 * not cancel the CRM meeting. The current id still belongs to that row.
 */
export function zoomDeleteApplies(currentZoomId: string | null | undefined, deletedId: string): boolean {
  if (!deletedId) return false;
  if (!currentZoomId) return true;
  return currentZoomId === deletedId;
}
