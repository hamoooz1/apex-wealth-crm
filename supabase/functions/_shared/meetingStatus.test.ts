import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deliveryKind,
  externalMeetingPatch,
  mergeProviderFields,
  mapCalendlyStatus,
  planCalendlyWrite,
  resolveStatusWrite,
  scrubProviderBody,
  tokenNeedsRefresh,
  zoomTimestampFresh,
  type MeetingMatch,
} from "./meetingStatus.ts";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const PAST = "2026-11-01T15:00:00.000Z";
const FUTURE = "2026-12-01T15:00:00.000Z";

const emptyMatch: MeetingMatch = {
  byInvitee: null,
  byOldInvitee: null,
  byAlias: null,
  byOldAlias: null,
};

describe("mapCalendlyStatus", () => {
  it("does not treat a no-show create as scheduled", () => {
    assert.equal(
      mapCalendlyStatus({ eventName: "invitee_no_show.created", endTime: FUTURE }, NOW),
      "no_show",
    );
    assert.equal(
      mapCalendlyStatus({ eventName: "invitee.created", noShow: true, endTime: PAST }, NOW),
      "no_show",
    );
  });

  it("maps cancel, no-show delete, and past bookings", () => {
    assert.equal(mapCalendlyStatus({ eventName: "invitee.canceled", endTime: FUTURE }, NOW), "canceled");
    assert.equal(
      mapCalendlyStatus({ inviteeStatus: "canceled", endTime: PAST }, NOW),
      "canceled",
    );
    assert.equal(
      mapCalendlyStatus({ eventName: "invitee_no_show.deleted", endTime: FUTURE }, NOW),
      "scheduled",
    );
    assert.equal(
      mapCalendlyStatus({ eventName: "invitee_no_show.deleted", endTime: PAST }, NOW),
      "completed",
    );
    assert.equal(mapCalendlyStatus({ eventName: "invitee.created", endTime: PAST }, NOW), "completed");
    assert.equal(mapCalendlyStatus({ eventName: "invitee.created", endTime: FUTURE }, NOW), "scheduled");
  });
});

describe("resolveStatusWrite", () => {
  it("leaves an advisor status in place", () => {
    assert.equal(
      resolveStatusWrite({ existingOrigin: "advisor", mapped: "completed", reschedule: false }),
      null,
    );
    assert.equal(
      resolveStatusWrite({ existingOrigin: "advisor", mapped: "no_show", reschedule: false }),
      null,
    );
  });

  it("does not revert a system auto-complete to scheduled, but accepts a no-show", () => {
    assert.equal(
      resolveStatusWrite({ existingOrigin: "system", mapped: "scheduled", reschedule: false }),
      null,
    );
    assert.deepEqual(
      resolveStatusWrite({ existingOrigin: "system", mapped: "no_show", reschedule: false }),
      { status: "no_show", status_origin: "provider" },
    );
  });

  it("lets a reschedule replace the previous status", () => {
    assert.deepEqual(
      resolveStatusWrite({ existingOrigin: "advisor", mapped: "scheduled", reschedule: true }),
      { status: "scheduled", status_origin: "provider" },
    );
  });
});

describe("planCalendlyWrite", () => {
  it("keeps group invitees as separate rows", () => {
    const first = planCalendlyWrite(emptyMatch, {
      eventName: "invitee.created",
      inviteeUri: "https://api.calendly.com/invitees/a",
      endTime: FUTURE,
    }, NOW);
    const second = planCalendlyWrite(emptyMatch, {
      eventName: "invitee.created",
      inviteeUri: "https://api.calendly.com/invitees/b",
      endTime: FUTURE,
    }, NOW);
    assert.equal(first.action, "insert");
    assert.equal(second.action, "insert");
    if (first.action === "insert" && second.action === "insert") {
      assert.notEqual(first.inviteeUri, second.inviteeUri);
    }
  });

  it("retargets the original row on reschedule and carries no CRM fields", () => {
    const plan = planCalendlyWrite(
      {
        ...emptyMatch,
        byOldInvitee: {
          id: "meeting-1",
          external_invitee_uri: "https://api.calendly.com/invitees/old",
          status_origin: "advisor",
        },
      },
      {
        eventName: "invitee.created",
        inviteeUri: "https://api.calendly.com/invitees/new",
        oldInviteeUri: "https://api.calendly.com/invitees/old",
        endTime: FUTURE,
      },
      NOW,
    );
    assert.equal(plan.action, "update");
    if (plan.action === "update") {
      assert.equal(plan.id, "meeting-1");
      assert.equal(plan.inviteeUri, "https://api.calendly.com/invitees/new");
      assert.equal(plan.aliasInviteeUri, "https://api.calendly.com/invitees/old");
      assert.equal(plan.status, "scheduled");
    }
    assert.deepEqual(
      Object.keys(externalMeetingPatch({
        title: "Intro",
        client_id: "c",
        lead_id: "l",
        notes: "keep me",
        status: "scheduled",
      })).sort(),
      ["status", "title"],
    );
  });

  it("does not cancel the original row when the old reschedule half arrives late", () => {
    const pending = planCalendlyWrite(
      {
        ...emptyMatch,
        byInvitee: {
          id: "meeting-1",
          external_invitee_uri: "https://api.calendly.com/invitees/old",
          status_origin: "provider",
        },
      },
      {
        eventName: "invitee.canceled",
        inviteeUri: "https://api.calendly.com/invitees/old",
        newInviteeUri: "https://api.calendly.com/invitees/new",
        rescheduled: true,
        inviteeStatus: "canceled",
        endTime: PAST,
      },
      NOW,
    );
    assert.equal(pending.action, "update");
    if (pending.action === "update") assert.equal(pending.touchOnly, true);

    const alreadyMoved = planCalendlyWrite(
      {
        ...emptyMatch,
        byAlias: {
          id: "meeting-1",
          external_invitee_uri: "https://api.calendly.com/invitees/new",
          status_origin: "provider",
        },
      },
      {
        eventName: "invitee.canceled",
        inviteeUri: "https://api.calendly.com/invitees/old",
        newInviteeUri: "https://api.calendly.com/invitees/new",
        rescheduled: true,
        inviteeStatus: "canceled",
      },
      NOW,
    );
    assert.deepEqual(alreadyMoved, { action: "skip", reason: "reschedule_already_applied" });
  });

  it("classifies the two halves of a reschedule", () => {
    assert.equal(deliveryKind({ oldInviteeUri: "old", rescheduled: false }), "reschedule_new");
    assert.equal(
      deliveryKind({ rescheduled: true, newInviteeUri: "new", inviteeStatus: "canceled" }),
      "reschedule_old",
    );
    assert.equal(deliveryKind({ eventName: "invitee.created" }), "normal");
  });
});

describe("webhook and token helpers", () => {
  it("rejects stale or missing Zoom timestamps", () => {
    assert.equal(zoomTimestampFresh("1700000000", 1700000000 + 60), true);
    assert.equal(zoomTimestampFresh("1700000000", 1700000000 + 301), false);
    assert.equal(zoomTimestampFresh(null, 1700000000), false);
    assert.equal(zoomTimestampFresh("nope", 1700000000), false);
  });

  it("refreshes tokens inside the skew window and scrubs secrets", () => {
    assert.equal(tokenNeedsRefresh({ access_token: "a", token_expires_at: new Date(NOW + 60_000).toISOString() }, NOW), true);
    assert.equal(tokenNeedsRefresh({ access_token: "a", token_expires_at: new Date(NOW + 30 * 60_000).toISOString() }, NOW), false);
    assert.equal(tokenNeedsRefresh(null, NOW), true);
    assert.equal(
      scrubProviderBody('{"error":"invalid_grant","refresh_token":"super-secret"}'),
      '{"error":"invalid_grant","refresh_token":"***"}',
    );
  });
});

describe("mergeProviderFields", () => {
  it("keeps advisor edits and still records the provider value", () => {
    const patch = mergeProviderFields({
      existingOrigins: { title: "advisor", start_time: "provider" },
      existingSnapshot: { title: "Old provider title" },
      incoming: {
        title: "Calendly title",
        start_time: "2026-12-01T15:00:00.000Z",
        notes: "do not write",
        client_id: "c",
        lead_id: "l",
        status: "scheduled",
      },
    });
    assert.equal(patch.title, undefined);
    assert.equal(patch.start_time, "2026-12-01T15:00:00.000Z");
    assert.equal(patch.notes, undefined);
    assert.equal(patch.client_id, undefined);
    assert.equal(patch.lead_id, undefined);
    assert.equal(patch.status, "scheduled");
    assert.equal((patch.provider_snapshot as { title: string }).title, "Calendly title");
    assert.equal((patch.field_origins as { title: string }).title, "advisor");
  });

  it("releases time and location locks on a reschedule, not the title", () => {
    const patch = mergeProviderFields({
      existingOrigins: { title: "advisor", start_time: "advisor", meeting_url: "advisor" },
      incoming: {
        title: "Discovery",
        start_time: "2026-12-02T15:00:00.000Z",
        meeting_url: "https://zoom.us/j/83726104521",
      },
      release: ["start_time", "end_time", "meeting_url", "location", "meeting_type", "zoom_meeting_id", "zoom_meeting_uuid"],
    });
    assert.equal(patch.title, undefined);
    assert.equal(patch.start_time, "2026-12-02T15:00:00.000Z");
    assert.equal(patch.meeting_url, "https://zoom.us/j/83726104521");
    const origins = patch.field_origins as Record<string, string>;
    assert.equal(origins.title, "advisor");
    assert.equal(origins.start_time, "provider");
    assert.equal(origins.meeting_url, "provider");
  });
});
