import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_ALLOWED_HOSTS,
  TOKEN_COOKIE,
  evaluateRequestGuard,
  guardConfigFromEnv,
  hostnameOf,
  isSameOrigin,
  readCookie,
  safeEqual,
  serializeTokenCookie,
  type GuardConfig,
} from "../lib/request-guard";

const OPEN: GuardConfig = { token: null, allowedHosts: [] };

function req(method: string, path = "/", headers: Record<string, string> = {}): Request {
  const h = new Headers({ host: "localhost:3000", ...headers });
  return new Request(`http://localhost:3000${path}`, { method, headers: h });
}

beforeEach(() => {
  delete process.env.PINION_TOKEN;
  delete process.env.PINION_ALLOWED_HOSTS;
});

describe("hostnameOf", () => {
  test("strips the port and lowercases", () => {
    expect(hostnameOf("LOCALHOST:3000")).toBe("localhost");
    expect(hostnameOf("192.168.1.5:8080")).toBe("192.168.1.5");
    expect(hostnameOf("localhost")).toBe("localhost");
  });

  test("unwraps bracketed IPv6 and keeps a stray port out of it", () => {
    expect(hostnameOf("[::1]:3000")).toBe("::1");
    expect(hostnameOf("[::1]")).toBe("::1");
  });

  test("treats a bare IPv6 literal as one hostname", () => {
    expect(hostnameOf("::1")).toBe("::1");
  });

  test("null/empty input has no hostname", () => {
    expect(hostnameOf(null)).toBeNull();
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf("   ")).toBeNull();
  });
});

describe("isSameOrigin", () => {
  test("accepts the exact host", () => {
    expect(isSameOrigin("http://localhost:3000", "localhost:3000", "http")).toBe(true);
    expect(isSameOrigin("https://pinion.example", "pinion.example", "https")).toBe(true);
  });

  test("rejects a different host, port or scheme", () => {
    expect(isSameOrigin("http://evil.example", "localhost:3000", "http")).toBe(false);
    expect(isSameOrigin("http://localhost:9999", "localhost:3000", "http")).toBe(false);
    expect(isSameOrigin("https://localhost:3000", "localhost:3000", "http")).toBe(false);
  });

  test("rejects the opaque origin and unparseable values", () => {
    expect(isSameOrigin("null", "localhost:3000", "http")).toBe(false);
    expect(isSameOrigin("not a url", "localhost:3000", "http")).toBe(false);
    expect(isSameOrigin(null, "localhost:3000", "http")).toBe(false);
    expect(isSameOrigin("http://localhost:3000", null, "http")).toBe(false);
  });
});

describe("guardConfigFromEnv", () => {
  test("defaults to an open local config", () => {
    expect(guardConfigFromEnv({})).toEqual({ token: null, allowedHosts: [] });
  });

  test("parses token and comma-separated hosts", () => {
    expect(
      guardConfigFromEnv({
        PINION_TOKEN: " s3cret ",
        PINION_ALLOWED_HOSTS: "192.168.1.5, My-Laptop.local ,,",
      }),
    ).toEqual({ token: "s3cret", allowedHosts: ["192.168.1.5", "my-laptop.local"] });
  });
});

describe("cookie helpers", () => {
  test("readCookie finds the value among other cookies", () => {
    expect(readCookie("a=1; pinion_token=abc; b=2", TOKEN_COOKIE)).toBe("abc");
    expect(readCookie("a=1", TOKEN_COOKIE)).toBeNull();
    expect(readCookie(null, TOKEN_COOKIE)).toBeNull();
  });

  test("serializeTokenCookie is HttpOnly + SameSite=Strict and URL-encodes", () => {
    const cookie = serializeTokenCookie("a b/c");
    expect(cookie).toContain(`${TOKEN_COOKIE}=a%20b%2Fc`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(serializeTokenCookie("x", true)).toContain("Secure");
  });

  test("safeEqual compares without early exit semantics", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("evaluateRequestGuard — host allowlist (DNS rebinding)", () => {
  test("allows the default local hosts", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(evaluateRequestGuard(req("GET", "/", { host }), OPEN)).toEqual({ action: "allow" });
    }
  });

  test("denies an unknown Host even for safe reads", () => {
    const decision = evaluateRequestGuard(req("GET", "/api/sessions", { host: "evil.example" }), OPEN);
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.status).toBe(403);
  });

  test("denies a missing Host", () => {
    const bare = new Request("http://localhost:3000/", { method: "GET" });
    bare.headers.delete("host");
    expect(evaluateRequestGuard(bare, OPEN).action).toBe("deny");
  });

  test("honours PINION_ALLOWED_HOSTS", () => {
    const cfg: GuardConfig = { token: null, allowedHosts: ["192.168.1.5", "my-laptop.local"] };
    expect(evaluateRequestGuard(req("GET", "/", { host: "192.168.1.5:3000" }), cfg)).toEqual({
      action: "allow",
    });
    expect(evaluateRequestGuard(req("GET", "/", { host: "evil.example" }), cfg).action).toBe("deny");
  });

  test("DEFAULT_ALLOWED_HOSTS stays local-only", () => {
    expect([...DEFAULT_ALLOWED_HOSTS].sort()).toEqual(["127.0.0.1", "::1", "localhost"]);
  });
});

describe("evaluateRequestGuard — cross-site mutations (CSRF)", () => {
  test("allows a same-origin POST", () => {
    const decision = evaluateRequestGuard(
      req("POST", "/api/sessions/x/bash", {
        origin: "http://localhost:3000",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      }),
      OPEN,
    );
    expect(decision).toEqual({ action: "allow" });
  });

  test("allows a non-browser client with no Origin and no Sec-Fetch-Site", () => {
    expect(evaluateRequestGuard(req("POST", "/api/sessions/x/bash"), OPEN)).toEqual({
      action: "allow",
    });
  });

  test("denies the text/plain drive-by exploit (Origin mismatch)", () => {
    const decision = evaluateRequestGuard(
      req("POST", "/api/sessions/x/bash", {
        origin: "https://evil.example",
        "content-type": "text/plain",
      }),
      OPEN,
    );
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.status).toBe(403);
  });

  test("denies cross-site even with no Origin when Sec-Fetch-Site says so", () => {
    const decision = evaluateRequestGuard(
      req("POST", "/api/sessions/x/bash", { "sec-fetch-site": "cross-site" }),
      OPEN,
    );
    expect(decision.action).toBe("deny");
  });

  test("denies a same-site (subdomain) mutation", () => {
    expect(
      evaluateRequestGuard(req("POST", "/api/projects", { "sec-fetch-site": "same-site" }), OPEN)
        .action,
    ).toBe("deny");
  });

  test("denies an opaque Origin", () => {
    expect(evaluateRequestGuard(req("POST", "/api/projects", { origin: "null" }), OPEN).action).toBe(
      "deny",
    );
  });

  test("safe methods are not origin-checked (host allowlist still applies)", () => {
    expect(
      evaluateRequestGuard(req("GET", "/api/sessions", { origin: "https://evil.example" }), OPEN),
    ).toEqual({ action: "allow" });
    expect(
      evaluateRequestGuard(req("POST", "/api/sessions", { origin: "https://evil.example" }), OPEN)
        .action,
    ).toBe("deny");
  });
});

describe("evaluateRequestGuard — optional shared token", () => {
  const cfg: GuardConfig = { token: "s3cret", allowedHosts: [] };

  test("requires the token for reads too", () => {
    const decision = evaluateRequestGuard(req("GET", "/api/sessions"), cfg);
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.status).toBe(401);
  });

  test("accepts the token cookie", () => {
    expect(
      evaluateRequestGuard(req("GET", "/api/sessions", { cookie: `${TOKEN_COOKIE}=s3cret` }), cfg),
    ).toEqual({ action: "allow" });
  });

  test("rejects a wrong token", () => {
    const decision = evaluateRequestGuard(
      req("GET", "/api/sessions", { cookie: `${TOKEN_COOKIE}=nope` }),
      cfg,
    );
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.status).toBe(401);
  });

  test("exchanges a ?token= query for a cookie via redirect", () => {
    const decision = evaluateRequestGuard(req("GET", "/?token=s3cret&x=1"), cfg);
    expect(decision.action).toBe("redirect");
    if (decision.action === "redirect") {
      expect(decision.location).toBe("/?x=1");
      expect(decision.setCookie).toContain(`${TOKEN_COOKIE}=s3cret`);
    }
  });

  test("does not mint a cookie from a bad query token", () => {
    const decision = evaluateRequestGuard(req("GET", "/?token=nope"), cfg);
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.status).toBe(401);
  });

  test("token mode still enforces the host allowlist", () => {
    const decision = evaluateRequestGuard(
      req("GET", "/", { host: "evil.example", cookie: `${TOKEN_COOKIE}=s3cret` }),
      cfg,
    );
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.status).toBe(403);
  });

  test("a cross-site POST is rejected before the token is even considered", () => {
    const decision = evaluateRequestGuard(
      req("POST", "/api/sessions/x/bash", {
        origin: "https://evil.example",
        cookie: `${TOKEN_COOKIE}=s3cret`,
      }),
      cfg,
    );
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.status).toBe(403);
  });
});
