import { zoomPathId } from "./zoomMeetings.ts";

export type ZoomMeetingBody = {
  topic: string;
  start_time: string;
  duration: number;
  timezone: string;
};

export type ZoomMeetingResult = {
  id: string;
  join_url: string | null;
  start_url: string | null;
  password: string | null;
  start_time: string | null;
  duration: number | null;
  timezone: string | null;
  uuid: string | null;
};

function meetingPayload(body: ZoomMeetingBody) {
  return {
    topic: body.topic,
    type: 2,
    start_time: body.start_time,
    duration: body.duration,
    timezone: body.timezone,
    settings: {
      join_before_host: false,
      waiting_room: true,
      host_video: true,
      participant_video: false,
      mute_upon_entry: true,
      approval_type: 2,
      auto_recording: "cloud",
    },
  };
}

async function zoomJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Zoom request failed (${res.status}): ${text.slice(0, 220)}`);
  }
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function asMeeting(m: Record<string, unknown>, fallback: ZoomMeetingBody): ZoomMeetingResult {
  return {
    id: String(m.id),
    join_url: typeof m.join_url === "string" ? m.join_url : null,
    start_url: typeof m.start_url === "string" ? m.start_url : null,
    password: typeof m.password === "string" ? m.password : null,
    start_time: typeof m.start_time === "string" ? m.start_time : fallback.start_time,
    duration: typeof m.duration === "number" ? m.duration : fallback.duration,
    timezone: typeof m.timezone === "string" ? m.timezone : fallback.timezone,
    uuid: typeof m.uuid === "string" ? m.uuid : null,
  };
}

export async function createZoomApiMeeting(token: string, body: ZoomMeetingBody): Promise<ZoomMeetingResult> {
  const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(meetingPayload(body)),
  });
  return asMeeting(await zoomJson(res), body);
}

export async function updateZoomApiMeeting(token: string, meetingId: string, body: ZoomMeetingBody): Promise<void> {
  const res = await fetch(`https://api.zoom.us/v2/meetings/${zoomPathId(meetingId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      topic: body.topic,
      start_time: body.start_time,
      duration: body.duration,
      timezone: body.timezone,
    }),
  });
  if (res.status === 204) return;
  await zoomJson(res);
}

/** 404 counts as already gone so regenerate can replace a deleted meeting. */
export async function deleteZoomApiMeeting(token: string, meetingId: string): Promise<"deleted" | "missing"> {
  const res = await fetch(`https://api.zoom.us/v2/meetings/${zoomPathId(meetingId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 204 || res.status === 200) return "deleted";
  if (res.status === 404) return "missing";
  const text = await res.text().catch(() => "");
  throw new Error(`Zoom delete meeting failed (${res.status}): ${text.slice(0, 220)}`);
}

export async function notifyZoomDeauthorization(input: {
  clientId: string;
  clientSecret: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const basic = btoa(`${input.clientId}:${input.clientSecret}`);
  const payload = input.payload;
  const res = await fetch("https://api.zoom.us/oauth/data/compliance", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
    body: JSON.stringify({
      client_id: input.clientId,
      user_id: payload.user_id,
      account_id: payload.account_id,
      deauthorization_event_received: {
        user_data_retention: String(payload.user_data_retention ?? "false"),
        account_id: payload.account_id,
        user_id: payload.user_id,
        signature: payload.signature,
        deauthorization_time: payload.deauthorization_time,
        client_id: payload.client_id ?? input.clientId,
      },
      compliance_completed: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zoom data compliance failed (${res.status}): ${text.slice(0, 180)}`);
  }
}
