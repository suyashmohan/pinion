#!/usr/bin/env bun
/**
 * Dev/start launcher that binds Pinion to loopback by default.
 *
 * `next dev` and `next start` default to 0.0.0.0; for a tool with shell
 * access that is a footgun, so the npm scripts go through here instead.
 *
 *   bun run dev                 → http://127.0.0.1:3000
 *   PINION_HOST=0.0.0.0 bun run dev   → LAN (also set PINION_ALLOWED_HOSTS)
 *   PINION_PORT=4000 bun run start
 *
 * Extra arguments are forwarded to Next (`bun run dev -- --turbo`).
 */
import { resolveBind } from "../lib/net";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("Usage: bun scripts/next.ts <dev|start> [next args...]");
  process.exit(2);
}

let bind;
try {
  bind = resolveBind();
} catch (err) {
  console.error(`[pinion] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const { host, port } = bind;
const forwarded = process.argv.slice(3);
const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;

console.log(`[pinion] ${mode} → http://${displayHost}:${port} (bound to ${host})`);
if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  console.log(
    `[pinion] warning: bound to ${host}. Pinion can run shell commands — ` +
      `only expose it on networks you trust, and add the address you browse ` +
      `from to PINION_ALLOWED_HOSTS.`,
  );
}

// Bun.spawn does not inherit post-start env mutations — snapshot explicitly.
const proc = Bun.spawn(
  [process.execPath, "--bun", "next", mode, "-H", host, "-p", String(port), ...forwarded],
  { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env } },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  });
}

process.exit((await proc.exited) ?? 0);
