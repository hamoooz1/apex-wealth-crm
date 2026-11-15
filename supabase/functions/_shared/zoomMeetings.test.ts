import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractZoomMeetingIdFromText,
  recordingCopyDecision,
  summaryTextFromZoom,
  vttToText,
  zoomDeleteApplies,
  zoomFieldsFromLocation,
  zoomPathId,
  zoomRetentionAllowed,
} from "./zoomMeetings.ts";

describe("zoom meeting ids", () => {
  it("reads the id from a join URL, a Calendly location, and a zoom uri", () => {
    assert.equal(
      extractZoomMeetingIdFromText("https://us02web.zoom.us/j/83726104521?pwd=abc"),
      "83726104521",
    );
    assert.equal(
      extractZoomMeetingIdFromText("https://zoom.us/wc/join/83726104521"),
      "83726104521",
    );
    assert.equal(extractZoomMeetingIdFromText("zoom:83726104521"), "83726104521");
    assert.equal(extractZoomMeetingIdFromText("https://zoom.us/my/advisor"), null);

    const parsed = zoomFieldsFromLocation(
      {
        type: "zoom",
        status: "pushed",
        join_url: "https://zoom.us/j/83726104521?pwd=secret",
        data: { id: 83726104521, password: "secret" },
      },
      null,
      "https://api.calendly.com/scheduled_events/evt",
    );
    assert.equal(parsed.zoomMeetingId, "83726104521");
    assert.equal(parsed.passcode, "secret");
    assert.match(parsed.joinUrl || "", /zoom\.us\/j\/83726104521/);
  });

  it("falls back to the join URL when Calendly omits data.id", () => {
    const parsed = zoomFieldsFromLocation(
      { type: "zoom", join_url: "https://us06web.zoom.us/j/11122233344" },
      "https://us06web.zoom.us/j/11122233344",
    );
    assert.equal(parsed.zoomMeetingId, "11122233344");
  });

  it("double-encodes uuids that contain a slash", () => {
    assert.equal(zoomPathId("83726104521"), "83726104521");
    assert.equal(zoomPathId("abc/def=="), encodeURIComponent(encodeURIComponent("abc/def==")));
  });
});

describe("recordings and deauthorization", () => {
  it("copies transcripts and small media, and skips files Zoom will not fit in the function", () => {
    assert.equal(recordingCopyDecision({ file_type: "TRANSCRIPT", file_size: 20_000 }).copy, true);
    assert.equal(recordingCopyDecision({ file_type: "MP4", file_size: 10_000_000 }).copy, true);
    assert.equal(recordingCopyDecision({ file_type: "MP4", file_size: 80_000_000 }).reason, "too_large");
    assert.equal(recordingCopyDecision({ file_type: "CHAT" }).kind, "skip");
    assert.equal(recordingCopyDecision({ file_type: "TIMELINE" }).copy, false);
  });

  it("turns a VTT into readable text", () => {
    const text = vttToText(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello from the review.\n\nNOTE confidential\n",
    );
    assert.equal(text, "Hello from the review.");
  });

  it("builds a summary without requiring summary_content", () => {
    const text = summaryTextFromZoom({
      summary_overview: "Discussed the rollover.",
      next_steps: ["Send the form"],
    });
    assert.match(text, /rollover/);
    assert.match(text, /Send the form/);
  });

  it("treats Zoom's retention flag as a string", () => {
    assert.equal(zoomRetentionAllowed({ user_data_retention: "false" }), false);
    assert.equal(zoomRetentionAllowed({ user_data_retention: "true" }), true);
    assert.equal(zoomRetentionAllowed({}), false);
  });

  it("ignores deletion of a Zoom meeting that regenerate already replaced", () => {
    assert.equal(zoomDeleteApplies("222", "111"), false);
    assert.equal(zoomDeleteApplies("222", "222"), true);
    assert.equal(zoomDeleteApplies(null, "222"), true);
  });
});
