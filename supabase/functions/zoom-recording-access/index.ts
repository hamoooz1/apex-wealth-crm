import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";

// verify_jwt stays on. Returns a one-hour signed URL for a file this user can
// already read through meeting_recordings RLS, or the Zoom share page when the
// file was too large to copy.

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405, headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing Supabase env" }, { status: 500, headers: cors });
  }

  const authHeader = req.headers.get("authorization") || "";
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userRes, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userRes?.user?.id) return json({ error: "Unauthorized" }, { status: 401, headers: cors });

  let body: { recording_id?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }
  if (!body.recording_id) return json({ error: "recording_id is required" }, { status: 400, headers: cors });

  const recording = await userClient
    .from("meeting_recordings")
    .select("id, storage_path, transcript_storage_path, share_url, play_url, transcript_text")
    .eq("id", body.recording_id)
    .maybeSingle();
  if (recording.error) return json({ error: recording.error.message }, { status: 500, headers: cors });
  if (!recording.data?.id) return json({ error: "Recording not found" }, { status: 404, headers: cors });

  const row = recording.data as {
    storage_path: string | null;
    transcript_storage_path: string | null;
    share_url: string | null;
    play_url: string | null;
    transcript_text: string | null;
  };
  const kind = body.kind === "transcript" ? "transcript" : "media";
  const path = kind === "transcript" ? row.transcript_storage_path : row.storage_path;
  if (path) {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signed = await admin.storage.from("meeting-recordings").createSignedUrl(path, 60 * 60);
    if (signed.error || !signed.data?.signedUrl) {
      return json({ error: signed.error?.message || "Could not sign the recording" }, { status: 502, headers: cors });
    }
    return json({ ok: true, url: signed.data.signedUrl, source: "storage", expires_in: 3600 }, { headers: cors });
  }

  if (kind === "transcript" && row.transcript_text) {
    return json({ ok: true, transcript_text: row.transcript_text, source: "text" }, { headers: cors });
  }
  const share = row.share_url || row.play_url;
  if (share) return json({ ok: true, url: share, source: "zoom_share" }, { headers: cors });
  return json({ error: "No stored file or Zoom share link for this recording." }, { status: 404, headers: cors });
});
