import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function base64Url(bytes: ArrayBuffer) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  const b64 = btoa(bin);
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecodeToString(s: string) {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return atob(b64 + pad);
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
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function redirect(appUrl: string, params: Record<string, string>) {
  const u = new URL(`${appUrl.replace(/\/$/, "")}/settings`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString() } });
}

Deno.serve(async (req: Request) => {
  const APP_URL = Deno.env.get("APP_URL") || "http://localhost:5173";

  if (req.method !== "GET" && req.method !== "HEAD") {
    return redirect(APP_URL, { zoom: "error", message: "Method not allowed" });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ZOOM_CLIENT_ID = Deno.env.get("ZOOM_CLIENT_ID");
  const ZOOM_CLIENT_SECRET = Deno.env.get("ZOOM_CLIENT_SECRET");
  const ZOOM_REDIRECT_URL = Deno.env.get("ZOOM_REDIRECT_URL");
  const ZOOM_STATE_SECRET = Deno.env.get("ZOOM_STATE_SECRET");

  const missing = [
    !SUPABASE_URL && "SUPABASE_URL",
    !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
    !ZOOM_CLIENT_ID && "ZOOM_CLIENT_ID",
    !ZOOM_CLIENT_SECRET && "ZOOM_CLIENT_SECRET",
    !ZOOM_REDIRECT_URL && "ZOOM_REDIRECT_URL",
    !ZOOM_STATE_SECRET && "ZOOM_STATE_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    console.error("[zoom-callback] missing env:", missing.join(", "));
    return redirect(APP_URL, { zoom: "error", message: `Server not configured: missing ${missing.join(", ")}` });
  }

  const reqUrl = new URL(req.url);
  const err = reqUrl.searchParams.get("error");
  if (err) {
    const desc = reqUrl.searchParams.get("error_description") || "";
    console.error("[zoom-callback] provider error:", err, desc);
    return redirect(APP_URL, { zoom: "error", message: `${err} ${desc}`.trim() });
  }
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");
  if (!code || !state) {
    return redirect(APP_URL, { zoom: "error", message: "Missing code or state" });
  }

  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) {
    return redirect(APP_URL, { zoom: "error", message: "Bad state" });
  }
  const expectedSig = await hmacSha256Base64Url(ZOOM_STATE_SECRET!, payloadB64);
  if (!timingSafeEq(sig, expectedSig)) {
    console.error("[zoom-callback] state signature mismatch");
    return redirect(APP_URL, { zoom: "error", message: "State signature mismatch" });
  }
  let payload: { uid: string; ts: number; nonce: string };
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch {
    return redirect(APP_URL, { zoom: "error", message: "State decode failed" });
  }
  if (!payload?.uid || !payload?.nonce || !payload?.ts) {
    return redirect(APP_URL, { zoom: "error", message: "Incomplete state" });
  }
  const ageSec = Math.floor(Date.now() / 1000) - payload.ts;
  if (ageSec < 0 || ageSec > 900) {
    return redirect(APP_URL, { zoom: "error", message: "State expired" });
  }

  const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: stateRow } = await supabaseAdmin
    .from("zoom_oauth_states")
    .select("code_verifier")
    .eq("user_id", payload.uid)
    .eq("nonce", payload.nonce)
    .maybeSingle();
  const codeVerifier = stateRow?.code_verifier as string | undefined;
  if (!codeVerifier) {
    console.error("[zoom-callback] oauth state not found for uid/nonce");
    return redirect(APP_URL, { zoom: "error", message: "OAuth state not found" });
  }

  const basic = btoa(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`);
  const tokenRes = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ZOOM_REDIRECT_URL!,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => "");
    console.error("[zoom-callback] token exchange failed", tokenRes.status, txt);
    return redirect(APP_URL, { zoom: "error", message: `Token exchange failed (${tokenRes.status}): ${txt.slice(0, 200)}` });
  }
  const token = await tokenRes.json();
  const accessToken: string = token.access_token;
  const refreshToken: string | undefined = token.refresh_token;
  const expiresIn: number = Number(token.expires_in || 3600);
  const scopes: string[] = typeof token.scope === "string" ? token.scope.split(" ") : [];
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const meRes = await fetch("https://api.zoom.us/v2/users/me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!meRes.ok) {
    const txt = await meRes.text().catch(() => "");
    console.error("[zoom-callback] users/me failed", meRes.status, txt, "scopes=", scopes.join(","));
    return redirect(APP_URL, { zoom: "error", message: `users/me failed (${meRes.status}): ${txt.slice(0, 200)}` });
  }
  const me = await meRes.json();
  const zoomUserId: string = me.id;
  const zoomAccountId: string | null = me.account_id ?? null;
  const email: string | null = me.email ?? null;

  await supabaseAdmin.from("zoom_oauth_states").delete().eq("user_id", payload.uid);

  const { data: existingRows } = await supabaseAdmin
    .from("zoom_connections")
    .select("id, revoked_at, connected_at")
    .eq("user_id", payload.uid)
    .order("connected_at", { ascending: false });

  const rows = (existingRows || []) as { id: string; revoked_at: string | null }[];
  const active = rows.find((row) => !row.revoked_at);
  const revive = active || rows[0];

  let connectionId: string | undefined = revive?.id;
  if (connectionId) {
    await supabaseAdmin
      .from("zoom_connections")
      .update({
        zoom_user_id: zoomUserId,
        zoom_account_id: zoomAccountId,
        email,
        status: "connected",
        connected_at: new Date().toISOString(),
        revoked_at: null,
        webhook_last_error: null,
        token_status: "valid",
        last_sync_error: null,
      })
      .eq("id", connectionId);
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("zoom_connections")
      .insert({
        user_id: payload.uid,
        zoom_user_id: zoomUserId,
        zoom_account_id: zoomAccountId,
        email,
        status: "connected",
      })
      .select("id")
      .maybeSingle();
    if (insErr || !inserted?.id) {
      console.error("[zoom-callback] connection insert failed", insErr?.message);
      return redirect(APP_URL, { zoom: "error", message: insErr?.message?.slice(0, 200) || "Connection insert failed" });
    }
    connectionId = inserted.id;
  }

  const { error: tokErr } = await supabaseAdmin
    .from("zoom_connection_tokens")
    .upsert(
      {
        connection_id: connectionId,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: tokenExpiresAt,
        scopes,
      },
      { onConflict: "connection_id" },
    );
  if (tokErr) {
    console.error("[zoom-callback] token store failed", tokErr.message);
    return redirect(APP_URL, { zoom: "error", message: tokErr.message?.slice(0, 200) || "Token store failed" });
  }

  const health = await supabaseAdmin
    .from("zoom_connections")
    .update({
      token_expires_at: tokenExpiresAt,
      token_status: "valid",
      token_status_at: new Date().toISOString(),
      last_sync_error: null,
    })
    .eq("id", connectionId);
  if (health.error) console.warn("[zoom-callback] health mirror skipped", health.error.message);

  console.log("[zoom-callback] connected ok for uid", payload.uid, "zoomUser", zoomUserId);
  return redirect(APP_URL, { zoom: "connected" });
});
