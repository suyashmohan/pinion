export function piBinary(): string {
  return process.env.PI_BINARY?.trim() || "pi";
}

export function defaultCwd(): string {
  return (
    process.env.PI_DEFAULT_CWD?.trim() ||
    process.env.PINION_DEFAULT_CWD?.trim() ||
    process.cwd()
  );
}

export function extraArgs(): string[] {
  const raw = process.env.PI_EXTRA_ARGS?.trim();
  if (!raw) return [];
  // Minimal shell-like split supporting double quotes.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function rpcTimeoutMs(): number {
  const n = Number(process.env.PI_RPC_TIMEOUT_MS ?? "120000");
  return Number.isFinite(n) && n > 0 ? n : 120000;
}

/**
 * Idle time after which an unused pi process is reaped (respawned
 * transparently on next use). Default 15min; explicit 0 disables.
 */
export function piIdleTimeoutMs(): number {
  const raw = process.env.PI_IDLE_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return 15 * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 15 * 60_000;
  return n <= 0 ? 0 : n;
}

/**
 * Soft cap on concurrent pi processes (LRU idle eviction beyond it;
 * streaming sessions are never evicted). Default 10; 0 = unlimited.
 */
export function piMaxProcesses(): number {
  const raw = process.env.PI_MAX_PI_PROCESSES;
  if (raw == null || raw.trim() === "") return 10;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  return n <= 0 ? 0 : Math.floor(n);
}
