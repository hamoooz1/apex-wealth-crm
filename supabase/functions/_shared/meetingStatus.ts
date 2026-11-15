// Pure Calendly/Zoom sync rules. No I/O, so node can unit-test them.
//
// Status, field ownership, and (later) write-back decisions live here.
// Email linking lives in SQL so the backfill and the webhook share one path.

export type MeetingStatus = "scheduled" | "completed" | "canceled" | "no_show";
export type StatusOrigin = "provider" | "advisor" | "system";

export type CalendlyDelivery = {
  eventName?: string | null;
  eventStatus?: string | null;
  inviteeStatus?: string | null;
  noShow?: boolean;
  rescheduled?: boolean;
  inviteeUri?: string | null;
  oldInviteeUri?: string | null;
  newInviteeUri?: string | null;
  startTime?: string | null;
  endTime?: string | null;
};

export type MeetingSnap = {
  id: string;
  external_invitee_uri: string | null;
  status_origin: string | null;
};

export type MeetingMatch = {
  byInvitee: MeetingSnap | null;
  byOldInvitee: MeetingSnap | null;
  byAlias: MeetingSnap | null;
  byOldAlias: MeetingSnap | null;
};

export type WritePlan =
  | { action: "skip"; reason: string }
  | {
      action: "insert";
      inviteeUri: string;
      status: MeetingStatus;
      status_origin: StatusOrigin;
    }
  | {
      action: "update";
      id: string;
      /** Null keeps the current invitee URI (the old half of a reschedule). */
      inviteeUri: string | null;
      /** Old invitee URI to record as an alias before the row is retargeted. */
      aliasInviteeUri: string | null;
      reschedule: boolean;
      /** When true, only last_synced_at may be written. */
      touchOnly: boolean;
      status: MeetingStatus | null;
      status_origin: StatusOrigin | null;
    };

const ZOOM_SIGNATURE_SKEW_SEC = 5 * 60;

export function zoomTimestampFresh(headerValue: string | null, nowSec: number, skewSec = ZOOM_SIGNATURE_SKEW_SEC): boolean {
  if (!headerValue) return false;
  const ts = Number(headerValue);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowSec - ts) <= skewSec;
}

export function tokenNeedsRefresh(
  row: { access_token?: string | null; token_expires_at?: string | null } | null,
  nowMs = Date.now(),
  skewMs = 10 * 60 * 1000,
): boolean {
  if (!row?.access_token) return true;
  if (!row.token_expires_at) return true;
  const exp = new Date(row.token_expires_at).getTime();
  if (Number.isNaN(exp)) return true;
  return exp - nowMs < skewMs;
}

export function scrubProviderBody(body: string): string {
  return body.replace(/"(access_token|refresh_token)"\s*:\s*"[^"]*"/gi, '"$1":"***"').slice(0, 180);
}

function isCanceledText(value: string | null | undefined): boolean {
  const v = (value || "").toLowerCase();
  return v.includes("cancel");
}

function anchorMs(endTime?: string | null, startTime?: string | null): number | null {
  const raw = endTime || startTime;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function isPastMeeting(endTime: string | null | undefined, startTime: string | null | undefined, nowMs: number): boolean {
  const at = anchorMs(endTime, startTime);
  return at != null && at < nowMs;
}

/**
 * Map a Calendly webhook or invitee resource onto a CRM status.
 * `invitee_no_show.created` contains the substring "created"; no-show is checked
 * before that substring so it is not stored as scheduled.
 */
export function mapCalendlyStatus(input: CalendlyDelivery, nowMs = Date.now()): MeetingStatus {
  const name = (input.eventName || "").toLowerCase();
  if (name.includes("no_show") && name.includes("delet")) {
    return isPastMeeting(input.endTime, input.startTime, nowMs) ? "completed" : "scheduled";
  }
  if (input.noShow || name.includes("no_show")) return "no_show";
  if (
    isCanceledText(name) ||
    isCanceledText(input.eventStatus) ||
    isCanceledText(input.inviteeStatus)
  ) {
    return "canceled";
  }
  if (isPastMeeting(input.endTime, input.startTime, nowMs)) return "completed";
  return "scheduled";
}

export type DeliveryKind = "reschedule_old" | "reschedule_new" | "normal";

export function deliveryKind(delivery: CalendlyDelivery): DeliveryKind {
  if (delivery.oldInviteeUri) return "reschedule_new";
  const canceled =
    isCanceledText(delivery.eventName) ||
    isCanceledText(delivery.eventStatus) ||
    isCanceledText(delivery.inviteeStatus);
  if (delivery.rescheduled && canceled && delivery.newInviteeUri) return "reschedule_old";
  return "normal";
}

/**
 * Advisor-set status is left alone, except when the booking itself was rescheduled
 * onto a new invitee (that is a new occurrence on the same CRM row).
 * A system auto-complete is not reverted to scheduled, but a real no-show or
 * cancellation still replaces it.
 */
export function resolveStatusWrite(input: {
  existingOrigin: string | null | undefined;
  mapped: MeetingStatus;
  reschedule: boolean;
}): { status: MeetingStatus; status_origin: StatusOrigin } | null {
  if (input.reschedule) {
    return {
      status: input.mapped,
      status_origin: input.mapped === "completed" ? "system" : "provider",
    };
  }
  if (input.existingOrigin === "advisor") return null;
  if (input.existingOrigin === "system" && input.mapped === "scheduled") return null;
  return {
    status: input.mapped,
    status_origin: input.mapped === "completed" ? "system" : "provider",
  };
}

/**
 * Decide how one invitee delivery changes meetings.
 * Event URI is intentionally not an input: group events share one event URI
 * across invitees, and matching on it collapses those rows.
 */
export function planCalendlyWrite(match: MeetingMatch, delivery: CalendlyDelivery, nowMs = Date.now()): WritePlan {
  const kind = deliveryKind(delivery);
  const mapped = mapCalendlyStatus(delivery, nowMs);

  if (kind === "reschedule_old") {
    const row = match.byInvitee || match.byAlias;
    if (!row) return { action: "skip", reason: "reschedule_cancel_without_meeting" };
    if (
      delivery.inviteeUri &&
      row.external_invitee_uri &&
      row.external_invitee_uri !== delivery.inviteeUri
    ) {
      return { action: "skip", reason: "reschedule_already_applied" };
    }
    return {
      action: "update",
      id: row.id,
      inviteeUri: null,
      aliasInviteeUri: null,
      reschedule: false,
      touchOnly: true,
      status: null,
      status_origin: null,
    };
  }

  if (kind === "reschedule_new") {
    const row = match.byOldInvitee || match.byOldAlias;
    const statusWrite = resolveStatusWrite({
      existingOrigin: row?.status_origin ?? null,
      mapped,
      reschedule: true,
    });
    if (!delivery.inviteeUri) return { action: "skip", reason: "missing_invitee" };
    if (!row || !statusWrite) {
      return {
        action: "insert",
        inviteeUri: delivery.inviteeUri,
        status: statusWrite?.status ?? mapped,
        status_origin: statusWrite?.status_origin ?? "provider",
      };
    }
    return {
      action: "update",
      id: row.id,
      inviteeUri: delivery.inviteeUri,
      aliasInviteeUri: delivery.oldInviteeUri ?? null,
      reschedule: true,
      touchOnly: false,
      status: statusWrite.status,
      status_origin: statusWrite.status_origin,
    };
  }

  const row = match.byInvitee || match.byAlias;
  if (
    row &&
    delivery.inviteeUri &&
    row.external_invitee_uri &&
    row.external_invitee_uri !== delivery.inviteeUri
  ) {
    return { action: "skip", reason: "stale_invitee" };
  }
  const statusWrite = resolveStatusWrite({
    existingOrigin: row?.status_origin ?? null,
    mapped,
    reschedule: false,
  });
  if (!delivery.inviteeUri) return { action: "skip", reason: "missing_invitee" };
  if (!row) {
    return {
      action: "insert",
      inviteeUri: delivery.inviteeUri,
      status: statusWrite?.status ?? mapped,
      status_origin: statusWrite?.status_origin ?? (mapped === "completed" ? "system" : "provider"),
    };
  }
  return {
    action: "update",
    id: row.id,
    inviteeUri: delivery.inviteeUri,
    aliasInviteeUri: null,
    reschedule: false,
    touchOnly: false,
    status: statusWrite?.status ?? null,
    status_origin: statusWrite?.status_origin ?? null,
  };
}

/** Fields a provider sync is allowed to write. CRM-owned links and notes are absent on purpose. */
export function externalMeetingPatch(fields: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "client_id" || key === "lead_id" || key === "notes") continue;
    if (value === undefined) continue;
    patch[key] = value;
  }
  return patch;
}

/**
 * Provider columns sync may refresh until an advisor edits that column.
 * client_id, lead_id, and notes are never in this list.
 * status stays on status_origin, not field_origins.
 */
export const PROVIDER_OWNED_FIELDS = [
  "title",
  "start_time",
  "end_time",
  "meeting_type",
  "meeting_url",
  "location",
  "attendees",
  "advisor_id",
  "zoom_meeting_id",
  "zoom_meeting_uuid",
] as const;

/** A Calendly reschedule is a new occurrence, so these locks are released. */
export const RESCHEDULE_RELEASE_FIELDS = [
  "start_time",
  "end_time",
  "meeting_url",
  "location",
  "meeting_type",
  "zoom_meeting_id",
  "zoom_meeting_uuid",
] as const;

const PROVIDER_OWNED = new Set<string>(PROVIDER_OWNED_FIELDS);

function asOriginMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, origin] of Object.entries(value as Record<string, unknown>)) {
    if (origin === "advisor" || origin === "provider" || origin === "system") out[key] = origin;
  }
  return out;
}

function asSnapshot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

/**
 * Build the update a provider sync may apply.
 * Advisor-origin fields are left out of the patch (the database trigger
 * reverts them if a caller forgets). A reschedule passes those fields in
 * `release` and sets their origin back to provider in the same update.
 * provider_snapshot always records what the provider last said, including
 * values the CRM refused to copy.
 */
export function mergeProviderFields(input: {
  existingOrigins?: unknown;
  existingSnapshot?: unknown;
  incoming: Record<string, unknown>;
  release?: readonly string[];
}): Record<string, unknown> {
  const origins = asOriginMap(input.existingOrigins);
  const snapshot = asSnapshot(input.existingSnapshot);
  const release = new Set(input.release ?? []);
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input.incoming)) {
    if (value === undefined) continue;
    if (key === "client_id" || key === "lead_id" || key === "notes") continue;
    if (key === "field_origins" || key === "provider_snapshot") continue;
    if (PROVIDER_OWNED.has(key)) {
      snapshot[key] = value;
      const locked = origins[key] === "advisor" && !release.has(key);
      if (release.has(key) && origins[key] === "advisor") origins[key] = "provider";
      if (locked) continue;
      patch[key] = value;
      continue;
    }
    patch[key] = value;
  }

  patch.provider_snapshot = snapshot;
  patch.field_origins = origins;
  return patch;
}
