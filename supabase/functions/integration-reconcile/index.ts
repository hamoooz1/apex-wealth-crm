import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncCalendlyConnection } from "../_shared/calendlyMeetings.ts";
import { json, timingSafeEq } from "../_shared/http.ts";
import { ensureZoomAccessToken } from "../_shared/providerTokens.ts";

// verify_jwt: true. pg_cron calls this with the service-role JWT from Vault.
// A signed-in advisor cannot run a reconcile for every connection.

type CalendlyResult = {
  user_id: string;
  ok: boolean;
  events?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  error?: string;
};

type ZoomResult = {
  user_id: string;
  ok: boolean;
  refreshed?: boolean;
  status?: string;
  error?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const CALENDLY_CLIENT_ID = Deno.env.get("CALENDLY_CLIENT_ID");
  const CALENDLY_CLIENT_SECRET = Deno.env.get("CALENDLY_CLIENT_SECRET");
  const ZOOM_CLIENT_ID = Deno.env.get("ZOOM_CLIENT_ID");
  const ZOOM_CLIENT_SECRET = Deno.env.get("ZOOM_CLIENT_SECRET");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing Supabase env" }, { status: 500 });
  }

  const header = req.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!timingSafeEq(token, SUPABASE_SERVICE_ROLE_KEY)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const calendly: CalendlyResult[] = [];
  if (!CALENDLY_CLIENT_ID || !CALENDLY_CLIENT_SECRET) {
    calendly.push({ user_id: "", ok: false, error: "Missing Calendly client env" });
  } else {
    const { data, error } = await admin
      .from("calendly_connections")
      .select("id, user_id, calendly_user_uri")
      .is("revoked_at", null)
      .limit(500);
    if (error) return json({ error: error.message }, { status: 500 });
    for (const conn of data ?? []) {
      const row = conn as { id: string; user_id: string; calendly_user_uri: string | null };
      if (!row.calendly_user_uri) {
        calendly.push({ user_id: row.user_id, ok: false, error: "Missing Calendly user URI" });
        continue;
      }
      try {
        const stats = await syncCalendlyConnection(
          admin,
          { id: row.id, user_id: row.user_id, calendly_user_uri: row.calendly_user_uri },
          { clientId: CALENDLY_CLIENT_ID, clientSecret: CALENDLY_CLIENT_SECRET },
        );
        calendly.push({ user_id: row.user_id, ok: true, ...stats });
      } catch (e) {
        calendly.push({ user_id: row.user_id, ok: false, error: (e as Error).message || "Sync failed" });
      }
    }
  }

  const zoom: ZoomResult[] = [];
  const { data: zoomConns, error: zoomErr } = await admin
    .from("zoom_connections")
    .select("id, user_id")
    .is("revoked_at", null)
    .limit(500);
  if (zoomErr) return json({ error: zoomErr.message, calendly }, { status: 500 });

  for (const conn of zoomConns ?? []) {
    const row = conn as { id: string; user_id: string };
    if (!ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
      zoom.push({ user_id: row.user_id, ok: false, error: "Missing Zoom client env" });
      continue;
    }
    try {
      const result = await ensureZoomAccessToken(admin, row.id, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET);
      await admin
        .from("zoom_connections")
        .update({ last_reconcile_at: new Date().toISOString() })
        .eq("id", row.id);
      zoom.push({ user_id: row.user_id, ok: true, refreshed: result.refreshed, status: result.status });
    } catch (e) {
      zoom.push({ user_id: row.user_id, ok: false, error: (e as Error).message || "Zoom refresh failed" });
    }
  }

  const linked = await admin.rpc("link_meetings_to_people", { target_meeting: null });
  if (linked.error && !/link_meetings_to_people|schema cache|does not exist/i.test(linked.error.message || "")) {
    console.warn("[integration-reconcile] link skipped", linked.error.message);
  }

  return json({
    ok: calendly.every((r) => r.ok) && zoom.every((r) => r.ok),
    calendly,
    zoom,
    linked: linked.error ? null : linked.data,
  });
});
