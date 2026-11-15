import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyCalendlyInvitee, parseCalendlyWebhook } from "../_shared/calendlyMeetings.ts";
import { json, timingSafeEq } from "../_shared/http.ts";
import { beginWebhookEvent, finishWebhookEvent, sha256Hex } from "../_shared/webhookEvents.ts";

// verify_jwt: false. Calendly signs the body; the gateway must not require a user JWT.

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

function parseSignatureHeader(h: string | null) {
  if (!h) return null;
  const out: Record<string, string> = {};
  for (const part of h.split(",").map((p) => p.trim())) {
    const [k, v] = part.split("=");
    if (k && v) out[k] = v;
  }
  if (!out.t || !out.v1) return null;
  const t = Number(out.t);
  if (!Number.isFinite(t)) return null;
  return { t, v1: out.v1 };
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

  const expected = await hmacSha256Hex(CALENDLY_WEBHOOK_SIGNING_KEY, `${sig.t}.${rawBody}`);
  if (!timingSafeEq(sig.v1, expected)) return json({ error: "Invalid signature" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseCalendlyWebhook(body);
  if (!parsed.inviteeUri || !parsed.eventUri || !parsed.invitee) {
    return json({ error: "Missing event/invitee uri" }, { status: 400 });
  }
  if (parsed.organizerUris.length === 0) {
    return json({ error: "Could not determine organizer user uri" }, { status: 400 });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const eventKey = await sha256Hex(rawBody);
  const claim = await beginWebhookEvent(supabaseAdmin, "calendly", eventKey, parsed.eventName ?? null);
  if (claim === "duplicate") return json({ ok: true, duplicate: true });

  try {
    const { data: conns, error: connErr } = await supabaseAdmin
      .from("calendly_connections")
      .select("id, user_id, calendly_user_uri")
      .in("calendly_user_uri", parsed.organizerUris)
      .is("revoked_at", null);
    if (connErr) throw connErr;
    const conn = (conns ?? [])[0] as { id: string; user_id: string; calendly_user_uri: string } | undefined;
    if (!conn?.user_id) {
      await finishWebhookEvent(supabaseAdmin, "calendly", eventKey, { status: "ignored", error: "No connected user for organizer" });
      return json({ error: "No connected user for organizer" }, { status: 404 });
    }

    const result = await applyCalendlyInvitee(supabaseAdmin, {
      advisorId: conn.user_id,
      eventUri: parsed.eventUri,
      eventName: parsed.eventName ?? null,
      eventStatus: parsed.eventStatus ?? null,
      startTime: parsed.startTime ?? null,
      endTime: parsed.endTime ?? null,
      title: parsed.title,
      location: parsed.location,
      invitee: parsed.invitee,
    });

    const marked = await supabaseAdmin
      .from("calendly_connections")
      .update({ last_webhook_at: new Date().toISOString() })
      .eq("id", conn.id);
    if (marked.error && !/last_webhook_at/.test(marked.error.message || "")) {
      console.warn("[calendly-webhook] last_webhook_at skipped", marked.error.message);
    }

    await finishWebhookEvent(supabaseAdmin, "calendly", eventKey, { status: "processed" });
    return json({ ok: true, action: result });
  } catch (e) {
    const message = (e as Error).message || "Webhook failed";
    await finishWebhookEvent(supabaseAdmin, "calendly", eventKey, { status: "error", error: message });
    return json({ error: message }, { status: 500 });
  }
});
