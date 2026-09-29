/**
 * Isomorphic HTTP helper for the Pinion SDK.
 *
 * - Resolves `fetch` **lazily** (`opts.fetch ?? globalThis.fetch`) so tests can
 *   stub it after module import and SSR never captures an absent global.
 * - Defaults to `credentials: "include"` so the same-origin HttpOnly
 *   `pinion_token` cookie rides along.
 * - `opts.token` is for non-browser clients (loopback MCP deployment b): it
 *   sends `Cookie: pinion_token=<token>` explicitly, which a browser cannot do.
 *
 * No `bun:*`, no `next/server`, no `@/lib/db` — this module is bundled for the
 * browser.
 */

/** Cookie name of the optional shared token (`PINION_TOKEN`). */
export const TOKEN_COOKIE = "pinion_token";

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface HttpClientOptions {
  /** Default "". Same-origin in the web app. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * If set, every fetch sends `Cookie: pinion_token=<token>`.
   * The web app leaves this unset: `PINION_TOKEN` is HttpOnly and the browser
   * attaches it.
   */
  token?: string;
  /** Default "include" so same-origin fetch sends the HttpOnly cookie. */
  credentials?: RequestCredentials;
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: HttpClientOptions = {},
): Promise<ApiResult<T>> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { ok: false, error: "fetch is not available in this runtime" };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (opts.token) headers.Cookie = `${TOKEN_COOKIE}=${opts.token}`;

  const res = await doFetch(`${opts.baseUrl ?? ""}${path}`, {
    ...init,
    headers,
    credentials: opts.credentials ?? "include",
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `Request failed (${res.status})` };
  }
  const obj = body as { ok?: boolean; data?: T; error?: string };
  if (!res.ok || obj.ok === false) {
    return { ok: false, error: obj.error ?? `Request failed (${res.status})` };
  }
  return { ok: true, data: obj.data as T };
}

/** Thin wrapper matching the legacy `api()` call shape. */
export function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  return request<T>(path, init);
}
