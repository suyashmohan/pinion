import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { config as proxyConfig, proxy } from "../proxy";
import { TOKEN_COOKIE } from "../lib/request-guard";

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: new Headers({ host: "localhost:3000", ...headers }),
  });
}

/** NextResponse.next() is observable through the x-middleware-next marker. */
function isPassThrough(res: Response): boolean {
  return res.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  delete process.env.PINION_TOKEN;
  delete process.env.PINION_ALLOWED_HOSTS;
});

describe("proxy wiring", () => {
  test("the matcher covers API routes", () => {
    const matcher = proxyConfig.matcher;
    expect(matcher).toBeDefined();
    const patterns = Array.isArray(matcher) ? matcher : [matcher];
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => typeof p === "string" && p.includes("_next"))).toBe(true);
  });

  test("passes same-origin requests through", () => {
    const res = proxy(request("GET", "/api/sessions"));
    expect(isPassThrough(res)).toBe(true);
  });

  // Regression: a malicious page must not be able to drive the bash RPC with
  // a text/plain POST that skips CORS preflight.
  test("blocks the cross-site bash drive-by", () => {
    const res = proxy(
      request("POST", "/api/sessions/abc/bash", {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      }),
    );
    expect(res.status).toBe(403);
    expect(isPassThrough(res)).toBe(false);
  });

  test("blocks a rebinding Host on reads", () => {
    const res = proxy(request("GET", "/api/sessions", { host: "evil.example" }));
    expect(res.status).toBe(403);
  });

  test("allows a configured LAN host", () => {
    process.env.PINION_ALLOWED_HOSTS = "192.168.1.5";
    const res = proxy(request("GET", "/api/sessions", { host: "192.168.1.5:3000" }));
    expect(isPassThrough(res)).toBe(true);
  });

  test("denies API callers when a token is configured but missing", () => {
    process.env.PINION_TOKEN = "s3cret";
    const res = proxy(request("GET", "/api/sessions"));
    expect(res.status).toBe(401);
  });

  test("mints a cookie from ?token= and redirects without the secret", () => {
    process.env.PINION_TOKEN = "s3cret";
    const res = proxy(request("GET", "/?token=s3cret"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(res.headers.get("set-cookie") ?? "").toContain(`${TOKEN_COOKIE}=s3cret`);
  });

  test("honours a valid token cookie", () => {
    process.env.PINION_TOKEN = "s3cret";
    const res = proxy(request("GET", "/api/sessions", { cookie: `${TOKEN_COOKIE}=s3cret` }));
    expect(isPassThrough(res)).toBe(true);
  });
});
