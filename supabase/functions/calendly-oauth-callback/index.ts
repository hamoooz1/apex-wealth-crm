import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// v10: supports BOTH confidential (secret) and public (PKCE-only) clients

function base64UrlToBytes(s: string) {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64Url(bytes: ArrayBuffer) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  const b64 = btoa(bin);
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

function timingSafeEq(a: string, b: string) {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

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

function redirect(to: string) {
  return new Response(null, {
    status: 302,
    headers: {
      location: to,
      "cache-control": "no-store",
    },
  });
}

function safeMsg(e: unknown) {
  const s = String((e as any)?.message ?? e);
  return s.length > 500 ? s.slice(0, 500) : s;
}

async function fetchCalendlyMe(accessToken: string) {
  const res = await fetch("https://api.calendly.com/users/me", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Calendly /users/me failed (${res.status}): ${txt}`);
  }
  const body = await res.json();
  const uri = body?.resource?.uri;
  const organization = body?.resource?.current_organization;
  if (!uri) throw new Error("Calendly response missing resource.uri");
  return { uri, organization };
}

async function createWebhookSubscription(accessToken: string, webhookUrl: string, userUri: string, organizationUri?: string) {
  const payload: any = {
    url: webhookUrl,
    events: [
      "invitee.created",
      "invitee.canceled",
      "invitee_no_show.created",
      "invitee_no_show.deleted",
    ],
    scope: "user",
    user: userUri,
  };
  if (organizationUri) payload.organization = organizationUri;

  const res = await fetch("https://api.calendly.com/webhook_subscriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Calendly webhook subscription failed (${res.status}): ${txt}`);
  }

  const body = await res.json();
  const uri = body?.resource?.uri;
  if (!uri) throw new Error("Webhook response missing resource.uri");
  return { uri };
}

async function tokenExchange(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string | null;
}) {
  const baseBody = {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  };

  // Attempt 1: confidential client (Basic + secret)
  if (params.clientSecret) {
    const basic = btoa(`${params.clientId}:${params.clientSecret}`);
    const res = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams(baseBody),
    });

    if (res.ok) return await res.json();

    const txt = await res.text().catch(() => "");
    // If invalid_client, fall through and try PKCE public flow
    if (!txt.includes("invalid_client")) {
      throw new Error(`Token exchange failed (${res.status}): ${txt}`);
    }
  }

  // Attempt 2: public PKCE client (no secret, include client_id)
  const res2 = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      ...baseBody,
      client_id: params.clientId,
    }),
  });

  if (!res2.ok) {
    const txt2 = await res2.text().catch(() => "");
    throw new Error(`Token exchange failed (${res2.status}): ${txt2}`);
  }

  return await res2.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "HEAD") return new Response(null, { status: 200 });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });

  const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDesc = url.searchParams.get("error_description");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const CALENDLY_CLIENT_ID = Deno.env.get("CALENDLY_CLIENT_ID");
    const CALENDLY_CLIENT_SECRET = Deno.env.get("CALENDLY_CLIENT_SECRET");
    const CALENDLY_REDIRECT_URL = Deno.env.get("CALENDLY_REDIRECT_URL");
    const CALENDLY_STATE_SECRET = Deno.env.get("CALENDLY_STATE_SECRET");
    const CALENDLY_WEBHOOK_URL = Deno.env.get("CALENDLY_WEBHOOK_URL");

    if (error) {
      const q = new URLSearchParams({ calendly: "error", error, error_description: errorDesc ?? "", v: "10" });
      return APP_URL ? redirect(`${APP_URL}/settings?${q}`) : json({ error, error_description: errorDesc }, { status: 400 });
    }

    if (!code || !state) throw new Error("Missing code/state");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    if (!CALENDLY_CLIENT_ID || !CALENDLY_REDIRECT_URL || !CALENDLY_STATE_SECRET) {
      throw new Error("Missing CALENDLY_CLIENT_ID/REDIRECT_URL/STATE_SECRET");
    }

    const parts = state.split(".");
    if (parts.length !== 2) throw new Error("Invalid state format");
    const [payloadB64, sig] = parts;
    const expectedSig = await hmacSha256Base64Url(CALENDLY_STATE_SECRET, payloadB64);
    if (!timingSafeEq(sig, expectedSig)) throw new Error("Invalid state signature");

    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    } catch {
      throw new Error("Invalid state payload");
    }

    const uid = payload?.uid;
    const ts = payload?.ts;
    const nonce = payload?.nonce;
    if (!uid || typeof uid !== "string") throw new Error("State missing uid");
    if (!ts || typeof ts !== "number") throw new Error("State missing ts");
    if (!nonce || typeof nonce !== "string") throw new Error("State missing nonce");

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 15 * 60) throw new Error("State expired");

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: st, error: stErr } = await supabaseAdmin
      .from("calendly_oauth_states")
      .select("code_verifier")
      .eq("user_id", uid)
      .eq("nonce", nonce)
      .maybeSingle();
    if (stErr) throw stErr;
    const codeVerifier = st?.code_verifier;
    if (!codeVerifier) throw new Error("Missing PKCE verifier (try Connect again)");

    const tokenBody = await tokenExchange({
      code,
      redirectUri: CALENDLY_REDIRECT_URL,
      codeVerifier,
      clientId: CALENDLY_CLIENT_ID,
      clientSecret: CALENDLY_CLIENT_SECRET,
    });

    await supabaseAdmin.from("calendly_oauth_states").delete().eq("user_id", uid).eq("nonce", nonce);

    const accessToken = tokenBody?.access_token;
    const refreshToken = tokenBody?.refresh_token;
    const expiresIn = tokenBody?.expires_in;
    const scopeRaw = tokenBody?.scope;

    if (!accessToken) throw new Error("Missing access_token");

    const me = await fetchCalendlyMe(accessToken);

    const { data: existing, error: selErr } = await supabaseAdmin
      .from("calendly_connections")
      .select("*")
      .eq("user_id", uid)
      .is("revoked_at", null)
      .maybeSingle();
    if (selErr) throw selErr;

    let connectionId: string;
    if (existing?.id) {
      const { data, error: upErr } = await supabaseAdmin
        .from("calendly_connections")
        .update({
          calendly_user_uri: me.uri,
          status: "connected",
          revoked_at: null,
          connected_at: new Date().toISOString(),
          webhook_last_error: null,
        })
        .eq("id", existing.id)
        .select("id")
        .maybeSingle();
      if (upErr) throw upErr;
      connectionId = data!.id;
    } else {
      const { data, error: insErr } = await supabaseAdmin
        .from("calendly_connections")
        .insert({ user_id: uid, calendly_user_uri: me.uri, status: "connected" })
        .select("id")
        .maybeSingle();
      if (insErr) throw insErr;
      connectionId = data!.id;
    }

    const tokenExpiresAt = typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
    const scopes = typeof scopeRaw === "string" ? scopeRaw.split(/[\s,]+/g).map((s: string) => s.trim()).filter(Boolean) : null;

    const { error: tokErr } = await supabaseAdmin
      .from("calendly_connection_tokens")
      .upsert(
        {
          connection_id: connectionId,
          access_token: accessToken,
          refresh_token: refreshToken ?? null,
          token_expires_at: tokenExpiresAt,
          scopes,
        },
        { onConflict: "connection_id" },
      );
    if (tokErr) throw tokErr;

    if (CALENDLY_WEBHOOK_URL) {
      try {
        const sub = await createWebhookSubscription(accessToken, CALENDLY_WEBHOOK_URL, me.uri, me.organization);
        await supabaseAdmin
          .from("calendly_connections")
          .update({ webhook_subscription_uri: sub.uri, webhook_last_error: null })
          .eq("id", connectionId);
      } catch (e) {
        await supabaseAdmin
          .from("calendly_connections")
          .update({ webhook_last_error: safeMsg(e) })
          .eq("id", connectionId);
      }
    }

    const q = new URLSearchParams({ calendly: "connected", v: "10" });
    return APP_URL ? redirect(`${APP_URL}/settings?${q}`) : json({ ok: true, connection_id: connectionId, v: 10 });
  } catch (e) {
    console.error("calendly-oauth-callback error v10", e);
    const q = new URLSearchParams({ calendly: "error", message: safeMsg(e), v: "10" });
    return APP_URL ? redirect(`${APP_URL}/settings?${q}`) : json({ error: safeMsg(e), v: 10 }, { status: 500 });
  }
});
