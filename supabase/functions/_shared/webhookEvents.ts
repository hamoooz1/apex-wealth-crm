import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Admin = ReturnType<typeof createClient>;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function logTableMissing(message: string): boolean {
  return /integration_webhook_events|schema cache|relation|does not exist/i.test(message);
}

/**
 * Claim a provider delivery. Identical retries of a finished delivery are duplicates.
 * A previous attempt that recorded status=error can be claimed again.
 * If the log table is not migrated yet, processing continues without idempotency.
 */
export async function beginWebhookEvent(
  admin: Admin,
  provider: "calendly" | "zoom",
  eventKey: string,
  eventType: string | null,
): Promise<"process" | "duplicate"> {
  const inserted = await admin
    .from("integration_webhook_events")
    .insert({
      provider,
      event_key: eventKey,
      event_type: eventType,
      status: "processing",
    })
    .select("id");

  if (!inserted.error) return "process";
  if (logTableMissing(inserted.error.message || "")) {
    console.warn("[webhook] event log unavailable; processing without idempotency");
    return "process";
  }
  if (inserted.error.code !== "23505") throw inserted.error;

  const existing = await admin
    .from("integration_webhook_events")
    .select("id, status, received_at")
    .eq("provider", provider)
    .eq("event_key", eventKey)
    .maybeSingle();
  if (existing.error) {
    if (logTableMissing(existing.error.message || "")) return "process";
    throw existing.error;
  }
  const row = existing.data as { id: string; status: string; received_at: string } | null;
  if (!row) return "process";
  if (row.status === "processed" || row.status === "ignored") return "duplicate";

  if (row.status === "error" || stuckProcessing(row)) {
    const claimed = await admin
      .from("integration_webhook_events")
      .update({
        status: "processing",
        error: null,
        received_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("id");
    if (claimed.error) {
      if (logTableMissing(claimed.error.message || "")) return "process";
      throw claimed.error;
    }
    if (claimed.data && claimed.data.length > 0) return "process";
  }
  return "duplicate";
}

function stuckProcessing(row: { status: string; received_at: string }): boolean {
  if (row.status !== "processing") return false;
  const age = Date.now() - new Date(row.received_at).getTime();
  return Number.isFinite(age) && age > 5 * 60 * 1000;
}

export async function finishWebhookEvent(
  admin: Admin,
  provider: "calendly" | "zoom",
  eventKey: string,
  result: { status: "processed" | "ignored" | "error"; error?: string | null },
) {
  const { error } = await admin
    .from("integration_webhook_events")
    .update({
      status: result.status,
      error: result.error ? result.error.slice(0, 500) : null,
      processed_at: new Date().toISOString(),
    })
    .eq("provider", provider)
    .eq("event_key", eventKey);
  if (error && !logTableMissing(error.message || "")) {
    console.warn("[webhook] could not finish event log", error.message);
  }
}
