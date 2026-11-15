import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  externalMeetingPatch,
  mergeProviderFields,
  planCalendlyWrite,
  RESCHEDULE_RELEASE_FIELDS,
  type CalendlyDelivery,
  type MeetingMatch,
  type MeetingSnap,
} from "./meetingStatus.ts";
import { ensureCalendlyAccessToken, markConnectionSynced } from "./providerTokens.ts";

type Admin = ReturnType<typeof createClient>;

export const CALENDLY_SYNC_PAST_DAYS = 90;
export const CALENDLY_SYNC_FUTURE_DAYS = 180;
export const CALENDLY_SYNC_MAX_PAGES = 20;

export function meetingUrlFromLocation(location: unknown): string | null {
  if (!location) return null;
  if (typeof location === "string") return location;
  if (typeof location !== "object") return null;
  const loc = location as Record<string, unknown>;
  if (typeof loc.join_url === "string") return loc.join_url;
  if (typeof loc.location === "string") return loc.location;
  if (typeof loc.uri === "string") return loc.uri;
  return null;
}

export function compactInvitee(invitee: Record<string, unknown> | null) {
  if (!invitee) return null;
  return {
    uri: invitee.uri ?? null,
    email: invitee.email ?? null,
    name: invitee.name ?? null,
    status: invitee.status ?? null,
    timezone: invitee.timezone ?? null,
    rescheduled: Boolean(invitee.rescheduled),
    old_invitee: invitee.old_invitee ?? null,
    new_invitee: invitee.new_invitee ?? null,
    no_show: invitee.no_show ?? null,
  };
}

type ParsedWebhook = CalendlyDelivery & {
  eventUri: string | null;
  title: string | null;
  location: unknown;
  organizerUris: string[];
  invitee: Record<string, unknown> | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function organizerUrisFromEvent(scheduled: Record<string, unknown> | null): string[] {
  const memberships = Array.isArray(scheduled?.event_memberships) ? scheduled.event_memberships : [];
  const uris = memberships
    .map((m) => (m && typeof m === "object" ? asString((m as Record<string, unknown>).user) : null))
    .filter((u): u is string => Boolean(u));
  return uris;
}

/** Official Calendly webhook shape, plus the older payload.event / payload.invitee shape. */
export function parseCalendlyWebhook(body: Record<string, unknown>): ParsedWebhook {
  const eventName = asString(body.event);
  const payload = (body.payload && typeof body.payload === "object" ? body.payload : body) as Record<string, unknown>;
  const scheduled = payload.scheduled_event && typeof payload.scheduled_event === "object"
    ? payload.scheduled_event as Record<string, unknown>
    : null;

  if (scheduled || (asString(payload.uri)?.includes("/invitees/"))) {
    return {
      eventName,
      eventUri: asString(scheduled?.uri) || asString(payload.event),
      inviteeUri: asString(payload.uri),
      oldInviteeUri: asString(payload.old_invitee),
      newInviteeUri: asString(payload.new_invitee),
      rescheduled: Boolean(payload.rescheduled),
      inviteeStatus: asString(payload.status),
      eventStatus: asString(scheduled?.status),
      noShow: Boolean(payload.no_show),
      startTime: asString(scheduled?.start_time),
      endTime: asString(scheduled?.end_time),
      title: asString(scheduled?.name),
      location: scheduled?.location ?? null,
      organizerUris: organizerUrisFromEvent(scheduled),
      invitee: payload,
    };
  }

  const legacyEvent = payload.event && typeof payload.event === "object"
    ? payload.event as Record<string, unknown>
    : null;
  const legacyInvitee = payload.invitee && typeof payload.invitee === "object"
    ? payload.invitee as Record<string, unknown>
    : null;
  return {
    eventName,
    eventUri: asString(legacyEvent?.uri),
    inviteeUri: asString(legacyInvitee?.uri),
    oldInviteeUri: asString(legacyInvitee?.old_invitee),
    newInviteeUri: asString(legacyInvitee?.new_invitee),
    rescheduled: Boolean(legacyInvitee?.rescheduled),
    inviteeStatus: asString(legacyInvitee?.status),
    eventStatus: asString(legacyEvent?.status),
    noShow: Boolean(legacyInvitee?.no_show),
    startTime: asString(legacyEvent?.start_time),
    endTime: asString(legacyEvent?.end_time),
    title: asString(legacyEvent?.name),
    location: legacyEvent?.location ?? null,
    organizerUris: organizerUrisFromEvent(legacyEvent),
    invitee: legacyInvitee,
  };
}

type Found = { snap: MeetingSnap; via: "invitee" | "alias" };

async function findInvitee(admin: Admin, uri: string | null): Promise<Found | null> {
  if (!uri) return null;
  const direct = await admin
    .from("meetings")
    .select("id, external_invitee_uri, status_origin")
    .eq("external_invitee_uri", uri)
    .maybeSingle();
  if (direct.error) throw direct.error;
  if (direct.data) return { snap: direct.data as MeetingSnap, via: "invitee" };

  const alias = await admin
    .from("meeting_external_aliases")
    .select("meeting_id")
    .eq("provider", "calendly")
    .eq("kind", "invitee")
    .eq("external_id", uri)
    .maybeSingle();
  if (alias.error) {
    if (/meeting_external_aliases|schema cache|relation|does not exist/i.test(alias.error.message || "")) return null;
    throw alias.error;
  }
  const aliasRow = alias.data as { meeting_id?: string } | null;
  if (!aliasRow?.meeting_id) return null;
  const row = await admin
    .from("meetings")
    .select("id, external_invitee_uri, status_origin")
    .eq("id", aliasRow.meeting_id)
    .maybeSingle();
  if (row.error) throw row.error;
  if (!row.data) return null;
  return { snap: row.data as MeetingSnap, via: "alias" };
}

async function rememberAlias(admin: Admin, meetingId: string, inviteeUri: string) {
  const { error } = await admin.from("meeting_external_aliases").upsert(
    {
      meeting_id: meetingId,
      provider: "calendly",
      kind: "invitee",
      external_id: inviteeUri,
      superseded_at: new Date().toISOString(),
    },
    { onConflict: "provider,kind,external_id" },
  );
  if (error) {
    if (/meeting_external_aliases|schema cache|relation|does not exist/i.test(error.message || "")) {
      console.warn("[calendly] alias table unavailable; reschedule still updates the same meeting row");
      return;
    }
    throw error;
  }
}

const OPTIONAL_COLUMNS = [
  "rescheduled_from_invitee_uri",
  "status_origin",
  "field_origins",
  "provider_snapshot",
  "zoom_meeting_id",
  "zoom_meeting_uuid",
  "invitee_email",
  "provider_summary",
];

async function writeMeeting(admin: Admin, id: string | null, patch: Record<string, unknown>): Promise<string | null> {
  const body = { ...patch };
  for (let attempt = 0; attempt < OPTIONAL_COLUMNS.length + 1; attempt++) {
    const result = id
      ? await admin.from("meetings").update(body).eq("id", id).select("id").maybeSingle()
      : await admin.from("meetings").insert(body).select("id").maybeSingle();
    if (!result.error) {
      const row = result.data as { id?: string } | null;
      return row?.id ?? id;
    }
    const message = result.error.message || "";
    const missing = OPTIONAL_COLUMNS.find((col) => message.includes(col) && Object.prototype.hasOwnProperty.call(body, col));
    if (!missing) throw result.error;
    delete body[missing];
  }
  throw new Error("Meeting write failed");
}

async function loadOwnership(admin: Admin, id: string): Promise<{ field_origins: unknown; provider_snapshot: unknown } | null> {
  const row = await admin
    .from("meetings")
    .select("field_origins, provider_snapshot")
    .eq("id", id)
    .maybeSingle();
  if (row.error) {
    if (/field_origins|provider_snapshot|schema cache|does not exist/i.test(row.error.message || "")) return null;
    throw row.error;
  }
  return (row.data as { field_origins: unknown; provider_snapshot: unknown } | null) ?? null;
}

export type ApplyResult = "inserted" | "updated" | "skipped";

export async function applyCalendlyInvitee(
  admin: Admin,
  input: {
    advisorId: string;
    eventUri: string;
    eventName?: string | null;
    eventStatus?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    title?: string | null;
    location?: unknown;
    invitee: Record<string, unknown>;
    nowMs?: number;
  },
): Promise<ApplyResult> {
  const nowMs = input.nowMs ?? Date.now();
  const delivery: CalendlyDelivery = {
    eventName: input.eventName ?? null,
    eventStatus: input.eventStatus ?? null,
    inviteeStatus: asString(input.invitee.status),
    noShow: Boolean(input.invitee.no_show),
    rescheduled: Boolean(input.invitee.rescheduled),
    inviteeUri: asString(input.invitee.uri),
    oldInviteeUri: asString(input.invitee.old_invitee),
    newInviteeUri: asString(input.invitee.new_invitee),
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
  };

  const inviteeFound = await findInvitee(admin, delivery.inviteeUri ?? null);
  const oldFound = await findInvitee(admin, delivery.oldInviteeUri ?? null);
  const match: MeetingMatch = {
    byInvitee: inviteeFound?.via === "invitee" ? inviteeFound.snap : null,
    byAlias: inviteeFound?.via === "alias" ? inviteeFound.snap : null,
    byOldInvitee: oldFound?.via === "invitee" ? oldFound.snap : null,
    byOldAlias: oldFound?.via === "alias" ? oldFound.snap : null,
  };
  const plan = planCalendlyWrite(match, delivery, nowMs);
  if (plan.action === "skip") return "skipped";

  const syncedAt = new Date(nowMs).toISOString();
  if (plan.action === "update" && plan.touchOnly) {
    await writeMeeting(admin, plan.id, { last_synced_at: syncedAt });
    return "updated";
  }

  if (plan.action === "update" && plan.aliasInviteeUri) {
    await rememberAlias(admin, plan.id, plan.aliasInviteeUri);
  }

  const meetingType = input.location && typeof input.location === "object"
    ? asString((input.location as Record<string, unknown>).type)
    : null;
  const incoming = externalMeetingPatch({
    source: "calendly",
    external_provider: "calendly",
    external_event_uri: input.eventUri,
    external_invitee_uri: plan.action === "insert" ? plan.inviteeUri : (plan.inviteeUri ?? undefined),
    advisor_id: input.advisorId,
    title: input.title || "Calendly Meeting",
    meeting_type: meetingType,
    meeting_url: meetingUrlFromLocation(input.location),
    location: input.location ?? null,
    attendees: { invitee: compactInvitee(input.invitee) },
    last_synced_at: syncedAt,
    start_time: input.startTime || undefined,
    end_time: input.endTime || undefined,
    status: plan.status ?? undefined,
    status_origin: plan.status_origin ?? undefined,
    rescheduled_from_invitee_uri: plan.action === "update" && plan.reschedule ? plan.aliasInviteeUri : undefined,
  });

  const owned = plan.action === "update" ? await loadOwnership(admin, plan.id) : null;
  const patch = mergeProviderFields({
    existingOrigins: owned?.field_origins,
    existingSnapshot: owned?.provider_snapshot,
    incoming,
    release: plan.action === "update" && plan.reschedule ? RESCHEDULE_RELEASE_FIELDS : [],
  });

  if (plan.action === "insert") {
    await writeMeeting(admin, null, patch);
    return "inserted";
  }
  await writeMeeting(admin, plan.id, patch);
  return "updated";
}

type PageJson = { collection?: unknown[]; pagination?: { next_page?: string | null } };

async function fetchJson(url: string, accessToken: string): Promise<PageJson> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Calendly request failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

async function listPages(firstUrl: string, accessToken: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let next: string | null = firstUrl;
  let pages = 0;
  while (next && pages < CALENDLY_SYNC_MAX_PAGES) {
    pages++;
    const body = await fetchJson(next, accessToken);
    for (const item of body.collection ?? []) {
      if (item && typeof item === "object") rows.push(item as Record<string, unknown>);
    }
    next = body.pagination?.next_page ?? null;
  }
  return rows;
}

async function listInvitees(eventUri: string, accessToken: string): Promise<Record<string, unknown>[]> {
  const uuid = eventUri.split("/").filter(Boolean).pop();
  if (!uuid) return [];
  const base = `https://api.calendly.com/scheduled_events/${uuid}/invitees?count=100`;
  const active = await listPages(`${base}&status=active`, accessToken);
  const canceled = await listPages(`${base}&status=canceled`, accessToken);
  return [...active, ...canceled];
}

export type SyncStats = {
  events: number;
  inserted: number;
  updated: number;
  skipped: number;
};

export async function syncCalendlyConnection(
  admin: Admin,
  connection: { id: string; user_id: string; calendly_user_uri: string },
  creds: { clientId: string; clientSecret: string },
): Promise<SyncStats> {
  const accessToken = await ensureCalendlyAccessToken(admin, connection.id, creds.clientId, creds.clientSecret);
  const minStart = new Date(Date.now() - CALENDLY_SYNC_PAST_DAYS * 86400000).toISOString();
  const maxStart = new Date(Date.now() + CALENDLY_SYNC_FUTURE_DAYS * 86400000).toISOString();
  const stats: SyncStats = { events: 0, inserted: 0, updated: 0, skipped: 0 };
  const seen = new Set<string>();
  let lastError: string | null = null;

  try {
    for (const eventStatus of ["active", "canceled"] as const) {
      const first =
        `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(connection.calendly_user_uri)}` +
        `&count=100&sort=start_time:asc&status=${eventStatus}` +
        `&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}`;
      const events = await listPages(first, accessToken);
      for (const evt of events) {
        const eventUri = asString(evt.uri);
        if (!eventUri) continue;
        stats.events++;
        try {
          const invitees = await listInvitees(eventUri, accessToken);
          for (const invitee of invitees) {
            const uri = asString(invitee.uri);
            if (!uri || seen.has(uri)) continue;
            seen.add(uri);
            const result = await applyCalendlyInvitee(admin, {
              advisorId: connection.user_id,
              eventUri,
              eventName: null,
              eventStatus: asString(evt.status),
              startTime: asString(evt.start_time),
              endTime: asString(evt.end_time),
              title: asString(evt.name),
              location: evt.location ?? null,
              invitee,
            });
            if (result === "inserted") stats.inserted++;
            else if (result === "updated") stats.updated++;
            else stats.skipped++;
          }
        } catch (e) {
          lastError = (e as Error).message || "Calendly event sync failed";
          stats.skipped++;
        }
      }
    }
  } catch (e) {
    const message = (e as Error).message || "Calendly sync failed";
    await markConnectionSynced(admin, "calendly_connections", connection.id, {
      last_sync_error: message.slice(0, 300),
      last_reconcile_at: new Date().toISOString(),
    });
    throw e;
  }

  await markConnectionSynced(admin, "calendly_connections", connection.id, {
    last_synced_at: new Date().toISOString(),
    last_reconcile_at: new Date().toISOString(),
    last_sync_error: lastError ? lastError.slice(0, 300) : null,
  });
  return stats;
}
