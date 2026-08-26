export const PRODUCTION_APP_URL = "https://apex-wealth-crm.vercel.app";

function isLocalHostname(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".localhost")
  );
}

function toPublicOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (isLocalHostname(url.hostname)) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Public site origin for invite/reset emails. Never returns localhost. */
export function resolveAppUrl(): string {
  const fromEnv = Deno.env.get("APP_URL") || Deno.env.get("PUBLIC_SITE_URL") || "";
  return toPublicOrigin(fromEnv) || PRODUCTION_APP_URL;
}

export function authRedirectTo(appUrl = resolveAppUrl()): string {
  return `${appUrl.replace(/\/$/, "")}/`;
}
