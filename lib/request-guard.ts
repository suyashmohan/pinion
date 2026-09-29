/**
 * Request guard: the single place that decides whether an inbound request may
 * touch Pinion.
 *
 * Pinion is a single-user, self-hosted tool whose API can execute shell
 * commands and read/write files. It deliberately has no login, so the only
 * things standing between a random web page and your machine are these two
 * checks:
 *
 * 1. **Host allowlist** — the `Host` header must be a name we expect
 *    (`localhost`/loopback by default, plus `PINION_ALLOWED_HOSTS`). This is
 *    what stops DNS rebinding: a page on `evil.example` that resolves to
 *    127.0.0.1 still sends `Host: evil.example`, which is rejected.
 * 2. **Same-origin mutations** — state-changing requests (anything that is
 *    not GET/HEAD/OPTIONS) must come from Pinion's own origin. Browsers attach
 *    `Origin` to cross-site POSTs, and a page cannot forge it. This stops
 *    CSRF, including the `fetch(..., { mode: "no-cors" })` + `text/plain`
 *    trick that skips CORS preflight — `readJson()` parses any body, so
 *    without this check a malicious page could drive `POST /bash`.
 *
 * An optional shared token (`PINION_TOKEN`) can additionally gate every
 * request for people who expose Pinion to a LAN. It is off by default.
 *
 * The logic is pure and framework-free so it can be unit tested without a
 * Next.js runtime; `proxy.ts` is a thin adapter over `evaluateRequestGuard`.
 */

export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export const TOKEN_COOKIE = "pinion_token";

/** One year, in seconds. */
const TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface GuardConfig {
  /** Shared secret required on every request when non-empty; null disables. */
  token: string | null;
  /** Extra hostnames (no scheme, no port) accepted in the Host header. */
  allowedHosts: string[];
}

export type GuardDecision =
  | { action: "allow" }
  | { action: "deny"; status: 401 | 403; message: string }
  | { action: "redirect"; location: string; setCookie: string };

export function guardConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GuardConfig {
  const token = env.PINION_TOKEN?.trim() || null;
  const allowedHosts = (env.PINION_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return { token, allowedHosts };
}

/**
 * Hostname from a `Host` header: lowercased, port removed, IPv6 brackets
 * unwrapped. Returns null when there is nothing usable to compare.
 */
export function hostnameOf(hostHeader: string | null | undefined): string | null {
  const raw = hostHeader?.trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? null : raw.slice(1, end);
  }
  // A bare IPv6 literal (technically invalid in Host, but tolerate it).
  if ((raw.match(/:/g) ?? []).length > 1) return raw;
  const colon = raw.lastIndexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon) || null;
}

/**
 * True when `origin` is Pinion's own origin. `requestHost` is the raw Host
 * header (with port), which is exactly the authority `URL.host` yields.
 */
export function isSameOrigin(
  origin: string | null | undefined,
  requestHost: string | null | undefined,
  requestProto: string,
): boolean {
  if (!origin || origin === "null" || !requestHost) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.protocol !== `${requestProto.toLowerCase()}:`) return false;
  return parsed.host.toLowerCase() === requestHost.trim().toLowerCase();
}

/** Read one cookie value out of a `Cookie` header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Constant-time-ish comparison. Length differences are visible, value
 * differences are not — good enough for a local shared secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function serializeTokenCookie(token: string, secure = false): string {
  return (
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${TOKEN_COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`
  );
}

/** Request scheme as seen by the client, honouring a TLS-terminating proxy. */
function requestProto(req: Request, url: URL): string {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded || url.protocol.replace(":", "");
}

export function evaluateRequestGuard(req: Request, config: GuardConfig): GuardDecision {
  const url = new URL(req.url);
  const host = req.headers.get("host");

  // 1. Host allowlist — applies to every method, including reads, because
  //    DNS rebinding otherwise leaks the whole API to any web page.
  const hostname = hostnameOf(host);
  const allowed = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  for (const extra of config.allowedHosts) allowed.add(extra);
  if (!hostname || !allowed.has(hostname)) {
    return {
      action: "deny",
      status: 403,
      message:
        `Host "${hostname ?? "(missing)"}" is not allowed. ` +
        `Use localhost, or add it to PINION_ALLOWED_HOSTS (comma-separated).`,
    };
  }

  const method = req.method.toUpperCase();
  const proto = requestProto(req, url);

  // 2. Optional shared token (off unless PINION_TOKEN is set).
  if (config.token) {
    const queryToken = url.searchParams.get("token");
    if (queryToken && (method === "GET" || method === "HEAD") && safeEqual(queryToken, config.token)) {
      url.searchParams.delete("token");
      return {
        action: "redirect",
        location: `${url.pathname}${url.search}${url.hash}`,
        setCookie: serializeTokenCookie(config.token, proto === "https"),
      };
    }
    const cookieToken = readCookie(req.headers.get("cookie"), TOKEN_COOKIE);
    if (!cookieToken || !safeEqual(cookieToken, config.token)) {
      return {
        action: "deny",
        status: 401,
        message: `Pinion token required. Open /?token=YOUR_TOKEN once to set the cookie.`,
      };
    }
  }

  // 3. Same-origin check for anything that changes state. Safe methods are
  //    left alone (the host allowlist above already blocks rebinding reads).
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const secFetchSite = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return { action: "deny", status: 403, message: "Cross-site request rejected." };
    }
    const origin = req.headers.get("origin");
    if (origin && !isSameOrigin(origin, host, proto)) {
      return { action: "deny", status: 403, message: "Cross-origin request rejected." };
    }
  }

  return { action: "allow" };
}
