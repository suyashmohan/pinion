/**
 * Bind address resolution for the dev/start launcher (`scripts/next.ts`).
 *
 * Pinion must not be reachable by accident: `next dev` and `next start` bind
 * 0.0.0.0 by default, which turns a machine-local tool with shell access into
 * a LAN service. We default to loopback and make LAN binding an explicit
 * opt-in via PINION_HOST (then `PINION_ALLOWED_HOSTS` opens the request guard
 * for the address you actually browse from).
 */

export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_BIND_PORT = 3000;

export interface BindConfig {
  host: string;
  port: number;
}

export function resolveBind(
  env: Record<string, string | undefined> = process.env,
): BindConfig {
  const host = env.PINION_HOST?.trim() || DEFAULT_BIND_HOST;
  const rawPort = env.PINION_PORT?.trim() || env.PORT?.trim() || "";
  if (!rawPort) return { host, port: DEFAULT_BIND_PORT };
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PINION_PORT/PORT value "${rawPort}": expected an integer between 1 and 65535.`,
    );
  }
  return { host, port };
}
