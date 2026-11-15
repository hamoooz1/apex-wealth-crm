import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scrubProviderBody, tokenNeedsRefresh } from "./meetingStatus.ts";

type Admin = ReturnType<typeof createClient>;

export type TokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
};

async function mirrorHealth(admin: Admin, table: string, connectionId: string, patch: Record<string, unknown>) {
  const { error } = await admin.from(table).update(patch).eq("id", connectionId);
  if (error) console.warn(`[${table}] health mirror skipped: ${error.message}`);
}

async function refreshCalendly(clientId: string, clientSecret: string, refreshToken: string) {
  const res = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Calendly token refresh failed (${res.status}): ${scrubProviderBody(txt)}`);
  }
  return await res.json();
}

async function refreshZoom(clientId: string, clientSecret: string, refreshToken: string) {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Zoom token refresh failed (${res.status}): ${scrubProviderBody(txt)}`);
  }
  return await res.json();
}

async function loadToken(admin: Admin, table: string, connectionId: string): Promise<TokenRow | null> {
  const { data, error } = await admin
    .from(table)
    .select("access_token, refresh_token, token_expires_at")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw error;
  return (data as TokenRow | null) ?? null;
}

async function storeRefreshed(
  admin: Admin,
  tokenTable: string,
  connectionTable: string,
  connectionId: string,
  refreshed: { access_token?: string; refresh_token?: string; expires_in?: number },
  previousRefresh: string | null,
) {
  const tokenExpiresAt = new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000).toISOString();
  const accessToken = refreshed.access_token;
  if (!accessToken) throw new Error("Token refresh returned no access_token");
  const { error } = await admin
    .from(tokenTable)
    .update({
      access_token: accessToken,
      refresh_token: refreshed.refresh_token ?? previousRefresh,
      token_expires_at: tokenExpiresAt,
    })
    .eq("connection_id", connectionId);
  if (error) throw error;
  await mirrorHealth(admin, connectionTable, connectionId, {
    token_expires_at: tokenExpiresAt,
    token_status: "valid",
    token_status_at: new Date().toISOString(),
    last_sync_error: null,
  });
  return accessToken;
}

export async function ensureCalendlyAccessToken(
  admin: Admin,
  connectionId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const tok = await loadToken(admin, "calendly_connection_tokens", connectionId);
  if (!tok?.access_token && !tok?.refresh_token) {
    await mirrorHealth(admin, "calendly_connections", connectionId, {
      token_status: "missing",
      token_status_at: new Date().toISOString(),
      last_sync_error: "Calendly tokens missing. Reconnect Calendly.",
    });
    throw new Error("Calendly tokens missing. Reconnect Calendly.");
  }
  if (!tokenNeedsRefresh(tok)) {
    await mirrorHealth(admin, "calendly_connections", connectionId, {
      token_expires_at: tok!.token_expires_at,
      token_status: "valid",
      token_status_at: new Date().toISOString(),
    });
    return tok!.access_token as string;
  }
  if (!tok?.refresh_token) {
    await mirrorHealth(admin, "calendly_connections", connectionId, {
      token_status: "expired",
      token_status_at: new Date().toISOString(),
      last_sync_error: "Calendly access token expired and no refresh token is stored.",
    });
    throw new Error("Calendly access token expired and no refresh token is stored.");
  }
  try {
    const refreshed = await refreshCalendly(clientId, clientSecret, tok.refresh_token);
    return await storeRefreshed(
      admin,
      "calendly_connection_tokens",
      "calendly_connections",
      connectionId,
      refreshed,
      tok.refresh_token,
    );
  } catch (e) {
    const message = (e as Error).message || "Token refresh failed";
    await mirrorHealth(admin, "calendly_connections", connectionId, {
      token_status: "refresh_failed",
      token_status_at: new Date().toISOString(),
      last_sync_error: message.slice(0, 300),
    });
    throw e;
  }
}

/** Refresh a Zoom token when it is missing or inside the skew window. */
export async function ensureZoomAccessToken(
  admin: Admin,
  connectionId: string,
  clientId: string,
  clientSecret: string,
): Promise<{ refreshed: boolean; status: "valid" | "missing" | "expired"; accessToken: string | null }> {
  const tok = await loadToken(admin, "zoom_connection_tokens", connectionId);
  if (!tok?.access_token && !tok?.refresh_token) {
    await mirrorHealth(admin, "zoom_connections", connectionId, {
      token_status: "missing",
      token_status_at: new Date().toISOString(),
      last_sync_error: "Zoom tokens missing. Reconnect Zoom.",
    });
    return { refreshed: false, status: "missing", accessToken: null };
  }
  if (!tokenNeedsRefresh(tok)) {
    await mirrorHealth(admin, "zoom_connections", connectionId, {
      token_expires_at: tok!.token_expires_at,
      token_status: "valid",
      token_status_at: new Date().toISOString(),
    });
    return { refreshed: false, status: "valid", accessToken: tok!.access_token };
  }
  if (!tok?.refresh_token) {
    await mirrorHealth(admin, "zoom_connections", connectionId, {
      token_status: "expired",
      token_status_at: new Date().toISOString(),
      last_sync_error: "Zoom access token expired and no refresh token is stored.",
    });
    return { refreshed: false, status: "expired", accessToken: null };
  }
  try {
    const refreshed = await refreshZoom(clientId, clientSecret, tok.refresh_token);
    const accessToken = await storeRefreshed(
      admin,
      "zoom_connection_tokens",
      "zoom_connections",
      connectionId,
      refreshed,
      tok.refresh_token,
    );
    return { refreshed: true, status: "valid", accessToken };
  } catch (e) {
    const message = (e as Error).message || "Token refresh failed";
    await mirrorHealth(admin, "zoom_connections", connectionId, {
      token_status: "refresh_failed",
      token_status_at: new Date().toISOString(),
      last_sync_error: message.slice(0, 300),
    });
    throw e;
  }
}

export async function markConnectionSynced(
  admin: Admin,
  table: "calendly_connections" | "zoom_connections",
  connectionId: string,
  patch: Record<string, unknown>,
) {
  await mirrorHealth(admin, table, connectionId, patch);
}
