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

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function base64Url(bytes: ArrayBuffer) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  const b64 = btoa(bin);
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Base64Url(message: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return base64Url(digest);
}

async function hmacSha256Base64Url(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64Url(sig);
}

function randomVerifier() {
  // 43-128 chars; use UUIDs combined
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const CALENDLY_CLIENT_ID = Deno.env.get("CALENDLY_CLIENT_ID");
  const CALENDLY_REDIRECT_URL = Deno.env.get("CALENDLY_REDIRECT_URL");
  const CALENDLY_STATE_SECRET = Deno.env.get("CALENDLY_STATE_SECRET");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY" }, { status: 500, headers: cors });
  }
  if (!CALENDLY_CLIENT_ID || !CALENDLY_REDIRECT_URL || !CALENDLY_STATE_SECRET) {
    return json(
      { error: "Missing CALENDLY_CLIENT_ID or CALENDLY_REDIRECT_URL or CALENDLY_STATE_SECRET" },
      { status: 500, headers: cors },
    );
  }

  const authHeader = req.headers.get("authorization") || "";
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userRes, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userRes?.user?.id) {
    return json({ error: "Unauthorized" }, { status: 401, headers: cors });
  }

  const userId = userRes.user.id;
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();

  // PKCE
  const codeVerifier = randomVerifier();
  const codeChallenge = await sha256Base64Url(codeVerifier);

  // Persist code_verifier server-side
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await supabaseAdmin.from("calendly_oauth_states").delete().eq("user_id", userId);
  const { error: insErr } = await supabaseAdmin
    .from("calendly_oauth_states")
    .insert({ user_id: userId, nonce, code_verifier: codeVerifier });
  if (insErr) {
    return json({ error: insErr.message || "Failed to persist oauth state" }, { status: 500, headers: cors });
  }

  const payload = { uid: userId, ts: now, nonce };
  const payloadB64 = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSha256Base64Url(CALENDLY_STATE_SECRET, payloadB64);
  const state = `${payloadB64}.${sig}`;

  const url = new URL("https://auth.calendly.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CALENDLY_CLIENT_ID);
  url.searchParams.set("redirect_uri", CALENDLY_REDIRECT_URL);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  const reqUrl = new URL(req.url);
  const scope = reqUrl.searchParams.get("scope");
  if (scope) url.searchParams.set("scope", scope);

  return json({ authorize_url: url.toString() }, { headers: cors });
});
