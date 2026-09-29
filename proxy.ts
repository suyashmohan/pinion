import { NextResponse, type NextRequest } from "next/server";
import { evaluateRequestGuard, guardConfigFromEnv } from "@/lib/request-guard";

/**
 * Next.js 16 proxy (the renamed middleware). Runs before every request and
 * enforces `lib/request-guard.ts`: Host allowlist for all methods, same-origin
 * for mutations, optional `PINION_TOKEN` for LAN exposure.
 *
 * Keep this file thin — all decision logic lives in the guard so it can be
 * unit tested without a Next.js runtime (`test/request-guard.test.ts`).
 */
export function proxy(req: NextRequest) {
  const decision = evaluateRequestGuard(req, guardConfigFromEnv());

  if (decision.action === "allow") return NextResponse.next();

  if (decision.action === "redirect") {
    const res = NextResponse.redirect(new URL(decision.location, req.url), 303);
    res.headers.append("Set-Cookie", decision.setCookie);
    return res;
  }

  const isApi = new URL(req.url).pathname.startsWith("/api/");
  if (isApi) {
    return NextResponse.json(
      { ok: false, error: decision.message },
      { status: decision.status },
    );
  }
  return new NextResponse(`Pinion: ${decision.message}\n`, {
    status: decision.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const config = {
  // Everything except Next's immutable build assets (the page itself must go
  // through the guard so `?token=` can mint its cookie).
  matcher: ["/((?!_next/static|_next/image).*)"],
};
