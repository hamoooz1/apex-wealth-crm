// What a CRM save or delete is allowed to push to Calendly and Zoom.
// Calendly can cancel a scheduled event. It cannot move the time.

export type WritebackAction = "save" | "delete";

export type WritebackPlan = {
  zoom: "delete" | "patch" | null;
  calendly: "cancel" | null;
  /** Shown when the CRM time changed and Calendly has no API to move the booking. */
  calendlyTimeNote: string | null;
  deleteRow: boolean;
};

const CALENDLY_TIME_NOTE =
  "Saved in the CRM. Calendly has no API to move an existing booking, so the Calendly time is unchanged. Cancel the meeting to cancel it on Calendly, or reschedule from Calendly.";

function sameTime(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  const left = Date.parse(a || "");
  const right = Date.parse(b || "");
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return left === right;
}

export function planProviderWriteback(input: {
  action: WritebackAction;
  source?: string | null;
  externalProvider?: string | null;
  zoomMeetingId?: string | null;
  calendlyEventUri?: string | null;
  before: { status?: string | null; start_time?: string | null; end_time?: string | null; title?: string | null };
  after: { status?: string | null; start_time?: string | null; end_time?: string | null; title?: string | null };
}): WritebackPlan {
  const calendly = input.source === "calendly" ||
    input.externalProvider === "calendly" ||
    (input.calendlyEventUri || "").includes("calendly.com");
  const zoom = Boolean(input.zoomMeetingId);
  const canceling = input.action === "delete" ||
    (input.after.status === "canceled" && input.before.status !== "canceled");
  const timeChanged = !sameTime(input.before.start_time, input.after.start_time) ||
    !sameTime(input.before.end_time, input.after.end_time);
  const titleChanged = (input.before.title || "") !== (input.after.title || "");

  if (input.action === "delete") {
    return {
      zoom: zoom ? "delete" : null,
      calendly: calendly ? "cancel" : null,
      calendlyTimeNote: null,
      deleteRow: true,
    };
  }

  if (canceling) {
    return {
      zoom: zoom ? "delete" : null,
      calendly: calendly ? "cancel" : null,
      calendlyTimeNote: null,
      deleteRow: false,
    };
  }

  const patchZoom = zoom && (timeChanged || titleChanged);
  return {
    zoom: patchZoom ? "patch" : null,
    calendly: null,
    calendlyTimeNote: calendly && timeChanged ? CALENDLY_TIME_NOTE : null,
    deleteRow: false,
  };
}

export function calendlyEventUuid(eventUri: string | null | undefined): string | null {
  if (!eventUri || !eventUri.includes("/scheduled_events/")) return null;
  const parts = eventUri.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("scheduled_events");
  const uuid = idx >= 0 ? parts[idx + 1] : "";
  return uuid || null;
}

export function calendlyCancelIsAlreadyGone(status: number, body: string): boolean {
  if (status === 404) return true;
  return /already canceled|already cancelled|not found/i.test(body);
}
