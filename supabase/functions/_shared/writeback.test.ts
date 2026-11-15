import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calendlyCancelIsAlreadyGone, calendlyEventUuid, planProviderWriteback } from "./writeback.ts";

const before = {
  status: "scheduled",
  start_time: "2026-12-01T15:00:00.000Z",
  end_time: "2026-12-01T15:30:00.000Z",
  title: "Intro",
};

describe("planProviderWriteback", () => {
  it("cancels Calendly and deletes Zoom when the CRM meeting is canceled", () => {
    const plan = planProviderWriteback({
      action: "save",
      source: "calendly",
      zoomMeetingId: "83726104521",
      calendlyEventUri: "https://api.calendly.com/scheduled_events/evt-1",
      before,
      after: { ...before, status: "canceled" },
    });
    assert.equal(plan.calendly, "cancel");
    assert.equal(plan.zoom, "delete");
    assert.equal(plan.calendlyTimeNote, null);
    assert.equal(plan.deleteRow, false);
  });

  it("does not pretend Calendly can move a booking, and does patch Zoom", () => {
    const plan = planProviderWriteback({
      action: "save",
      source: "calendly",
      externalProvider: "calendly",
      zoomMeetingId: "83726104521",
      calendlyEventUri: "https://api.calendly.com/scheduled_events/evt-1",
      before,
      after: { ...before, start_time: "2026-12-02T15:00:00.000Z" },
    });
    assert.equal(plan.calendly, null);
    assert.equal(plan.zoom, "patch");
    assert.match(plan.calendlyTimeNote || "", /no API to move/);
  });

  it("leaves a notes-only save alone", () => {
    const plan = planProviderWriteback({
      action: "save",
      source: "zoom",
      zoomMeetingId: "83726104521",
      before,
      after: { ...before, start_time: "2026-12-01T15:00:00.000Z" },
    });
    assert.equal(plan.zoom, null);
    assert.equal(plan.calendly, null);
  });

  it("deletes the CRM row only after the providers are asked to drop it", () => {
    const plan = planProviderWriteback({
      action: "delete",
      source: "calendly",
      zoomMeetingId: "83726104521",
      calendlyEventUri: "https://api.calendly.com/scheduled_events/evt-1",
      before,
      after: before,
    });
    assert.equal(plan.deleteRow, true);
    assert.equal(plan.calendly, "cancel");
    assert.equal(plan.zoom, "delete");
  });
});

describe("calendly cancel helpers", () => {
  it("reads the event uuid and treats an already-canceled event as success", () => {
    assert.equal(
      calendlyEventUuid("https://api.calendly.com/scheduled_events/EVT123/invitees/INV"),
      "EVT123",
    );
    assert.equal(calendlyCancelIsAlreadyGone(404, ""), true);
    assert.equal(calendlyCancelIsAlreadyGone(403, "Event is already canceled"), true);
    assert.equal(calendlyCancelIsAlreadyGone(403, "Please upgrade your Calendly account"), false);
  });
});
