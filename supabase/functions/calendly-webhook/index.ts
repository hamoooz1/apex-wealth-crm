import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
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
  for (let i = 0; i < len; i++) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function parseSignatureHeader(h: string | null) {
  if (!h) return null;
  const parts = h.split(",").map((p) => p.trim());
  const out: Record<string, string> = {};
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k && v) out[k] = v;
  }
  if (!out.t || !out.v1) return null;
  const t = Number(out.t);
  if (!Number.isFinite(t)) return null;
  return { t, v1: out.v1 };
}

function pickOrganizerUserUri(payload: any): string | null {
  const evt = payload?.event ?? payload?.payload?.event;
  if (!evt) return null;

  const direct = evt?.user || evt?.organizer || evt?.owner;
  if (typeof direct === "string") return direct;

  const membership = Array.isArray(evt?.event_memberships) ? evt.event_memberships[0] : null;
  const memUser = membership?.user;
  if (typeof memUser === "string") return memUser;

  const organizer = evt?.organizer;
  if (organizer && typeof organizer === "object" && typeof organizer?.uri === "string") return organizer.uri;

  return null;
}

function meetingUrlFromLocation(location: any): string | null {
  if (!location) return null;
  if (typeof location === "string") return location;
  if (typeof location?.join_url === "string") return location.join_url;
  if (typeof location?.location === "string") return location.location;
  if (typeof location?.uri === "string") return location.uri;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const CALENDLY_WEBHOOK_SIGNING_KEY = Deno.env.get("CALENDLY_WEBHOOK_SIGNING_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  if (!CALENDLY_WEBHOOK_SIGNING_KEY) {
    return json({ error: "Missing CALENDLY_WEBHOOK_SIGNING_KEY" }, { status: 500 });
  }

  const rawBody = await req.text();

  const sigHeader = req.headers.get("Calendly-Webhook-Signature") ?? req.headers.get("calendly-webhook-signature");
  const sig = parseSignatureHeader(sigHeader);
  if (!sig) return json({ error: "Missing/invalid signature" }, { status: 400 });

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - sig.t) > 5 * 60) return json({ error: "Signature timestamp out of range" }, { status: 400 });

  const signedPayload = `${sig.t}.${rawBody}`;
  const expected = await hmacSha256Hex(CALENDLY_WEBHOOK_SIGNING_KEY, signedPayload);
  if (!timingSafeEq(sig.v1, expected)) return json({ error: "Invalid signature" }, { status: 400 });

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = body?.event;
  const payload = body?.payload ?? body;
  const evt = payload?.event;
  const invitee = payload?.invitee;

  const externalEventUri = evt?.uri ?? null;
  const externalInviteeUri = invitee?.uri ?? null;

  if (!externalEventUri && !externalInviteeUri) {
    return json({ error: "Missing event/invitee uri" }, { status: 400 });
  }

  const organizerUri = pickOrganizerUserUri(payload);
  if (!organizerUri) return json({ error: "Could not determine organizer user uri" }, { status: 400 });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: conn, error: connErr } = await supabaseAdmin
    .from("calendly_connections")
    .select("user_id")
    .eq("calendly_user_uri", organizerUri)
    .is("revoked_at", null)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn?.user_id) return json({ error: "No connected user for organizer" }, { status: 404 });

  const advisorId = conn.user_id;

  const start = evt?.start_time ?? null;
  const end = evt?.end_time ?? null;
  const title = evt?.name ?? payload?.event_type?.name ?? "Calendly Meeting";
  const location = evt?.location ?? payload?.location ?? null;
  const meetingUrl = meetingUrlFromLocation(location);
  const meetingType = typeof location?.type === "string" ? location.type : null;

  let status: string | null = null;
  if (typeof eventType === "string") {
    const et = eventType.toLowerCase();
    if (et.includes("canceled") || et.includes("cancelled")) status = "canceled";
    else if (et.includes("created")) status = "scheduled";
    else if (et.includes("rescheduled")) status = "scheduled";
  }

  let existing: any = null;
  if (externalInviteeUri) {
    const res = await supabaseAdmin
      .from("meetings")
      .select("id")
      .eq("external_invitee_uri", externalInviteeUri)
      .maybeSingle();
    if (res.error) throw res.error;
    existing = res.data;
  }
  if (!existing && externalEventUri) {
    const res = await supabaseAdmin
      .from("meetings")
      .select("id")
      .eq("external_event_uri", externalEventUri)
      .maybeSingle();
    if (res.error) throw res.error;
    existing = res.data;
  }

  const basePatch: Record<string, any> = {
    source: "calendly",
    external_provider: "calendly",
    external_event_uri: externalEventUri,
    external_invitee_uri: externalInviteeUri,
    advisor_id: advisorId,
    title,
    meeting_type: meetingType,
    meeting_url: meetingUrl,
    location,
    attendees: invitee ? { invitee } : null,
    last_synced_at: new Date().toISOString(),
  };

  if (start) basePatch.start_time = start;
  if (end) basePatch.end_time = end;
  if (status) basePatch.status = status;

  if (existing?.id) {
    const { error: upErr } = await supabaseAdmin
      .from("meetings")
      .update(basePatch)
      .eq("id", existing.id);
    if (upErr) throw upErr;
    return json({ ok: true, action: "updated", id: existing.id });
  }

  const { data: ins, error: insErr } = await supabaseAdmin
    .from("meetings")
    .insert(basePatch)
    .select("id")
    .maybeSingle();
  if (insErr) throw insErr;

  return json({ ok: true, action: "inserted", id: ins?.id ?? null });
});
