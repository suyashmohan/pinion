import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { Emitter } from "../emitter";
import { dirExists } from "../files";
import { messages as messagesTable, sessions as sessionsTable } from "../db/schema";
import { piIdleTimeoutMs, piMaxProcesses } from "./env";
import { PiRpcClient } from "./rpc-client";
import type { PiEvent, RpcResponse } from "./types";
import type { AgentMessage, ProcessLimits, RunningProcessInfo } from "../control/types";

interface ManagedEntry {
  webId: string;
  /** Null when never spawned or after idle reap — entry (and SSE
   *  subscribers) survive so respawn is transparent. */
  client: PiRpcClient | null;
  cwd: string;
  emitter: Emitter;
  detach: () => void;
  lastSeen: number;
  /** True while the agent is working (agent_start..agent_settled) or
   *  compacting — such entries are never reaped or evicted. */
  busy: boolean;
  lastActivity: number;
  /** When the current child process was spawned (for the process panel). */
  startedAt: number;
  /** Wall-clock start of the in-flight agent turn (first `agent_start`). */
  turnStartedAt: number | null;
}

declare global {
  var __pinionManaged: Map<string, ManagedEntry> | undefined;
  var __pinionInflight: Map<string, Promise<PiRpcClient>> | undefined;
  var __pinionGlobalClient: PiRpcClient | undefined;
  var __pinionGlobalDetach: (() => void) | undefined;
  var __pinionGlobalStartedAt: number | undefined;
  var __pinionSweeperStarted: boolean | undefined;
}

function managedMap(): Map<string, ManagedEntry> {
  if (!globalThis.__pinionManaged) globalThis.__pinionManaged = new Map();
  return globalThis.__pinionManaged;
}

/** Broadcast a server-side synthesized event to SSE subscribers. */
export function broadcast(webId: string, ev: PiEvent): void {
  managedMap().get(webId)?.emitter.emit("sse", ev);
}

export function subscribe(webId: string, listener: (ev: PiEvent) => void): () => void {
  let entry = managedMap().get(webId);
  if (!entry) {
    // Create a lightweight placeholder emitter so SSE can attach before
    // the pi process is spawned (e.g. immediate navigation after create).
    const emitter = new Emitter();
    entry = {
      webId,
      client: null,
      cwd: "",
      emitter,
      detach: () => {},
      lastSeen: Date.now(),
      busy: false,
      lastActivity: Date.now(),
      startedAt: Date.now(),
      turnStartedAt: null,
    };
    managedMap().set(webId, entry);
  }
  entry.emitter.on("sse", listener);
  entry.lastSeen = Date.now();
  return () => {
    entry?.emitter.off("sse", listener);
  };
}

function attachForwarding(webId: string, client: PiRpcClient): () => void {
  const onEvent = (raw: PiEvent) => {
    const entry = managedMap().get(webId);
    let ev = raw;
    if (entry) {
      entry.lastActivity = Date.now();
      if (ev.type === "agent_start" || ev.type === "compaction_start") entry.busy = true;
      if (ev.type === "agent_settled" || ev.type === "compaction_end") entry.busy = false;
      if (ev.type === "agent_start" && entry.turnStartedAt == null) {
        // First start of the run wins: an auto-retry emits another
        // `agent_start`, but the whole turn is one user-visible wait.
        entry.turnStartedAt = Date.now();
      }
      if (ev.type === "agent_settled") {
        const startedAt = entry.turnStartedAt;
        entry.turnStartedAt = null;
        if (startedAt != null) {
          const durationMs = Math.max(0, Date.now() - startedAt);
          // Tag the live event with the same number that gets persisted, so
          // an open tab and a later refresh can never disagree.
          ev = { ...ev, durationMs };
          persistTurnDuration(webId, durationMs);
        }
      }
    }
    managedMap().get(webId)?.emitter.emit("sse", ev);
    // Best-effort persistence: reconcile the message cache once the
    // agent fully settles (covers retries / queued continuations).
    if (ev.type === "agent_settled" || ev.type === "compaction_end") {
      void syncMessagesFromPi(webId).catch((err) =>
        console.error(`[pi] sync after ${String(ev.type)} failed`, err),
      );
    }
    if (ev.type === "agent_end" || ev.type === "turn_end") {
      touchSession(webId);
    }
  };
  const onExit = (info: unknown) => {
    managedMap().get(webId)?.emitter.emit("sse", {
      type: "client_exit",
      info,
    } satisfies PiEvent);
  };
  client.on("event", onEvent);
  client.on("exit", onExit);
  return () => {
    client.off("event", onEvent);
    client.off("exit", onExit);
  };
}

function touchSession(webId: string) {
  void getDb()
    .then((db) =>
      db
        .update(sessionsTable)
        .set({ updatedAt: Date.now() })
        .where(eq(sessionsTable.id, webId))
        .run(),
    )
    .catch(() => {
      /* noop */
    });
}

/** Persist the completed turn's wall time (fire-and-forget, best effort). */
function persistTurnDuration(webId: string, durationMs: number): void {
  void getDb()
    .then((db) =>
      db
        .update(sessionsTable)
        .set({ lastTurnMs: durationMs })
        .where(eq(sessionsTable.id, webId))
        .run(),
    )
    .catch(() => {
      /* noop */
    });
}

/**
 * Return the live RPC client for a web session, spawning (or respawning)
 * the `pi --mode rpc` subprocess when needed.
 *
 * Concurrent callers (e.g. an SSE reconnect racing a REST call) share one
 * in-flight spawn so we never orphan duplicate pi processes.
 */
export function ensureClient(webId: string): Promise<PiRpcClient> {
  ensureSweeper();
  const existing = managedMap().get(webId);
  if (existing?.client?.alive) {
    existing.lastSeen = Date.now();
    existing.lastActivity = Date.now();
    return Promise.resolve(existing.client);
  }
  if (!globalThis.__pinionInflight) globalThis.__pinionInflight = new Map();
  const running = globalThis.__pinionInflight.get(webId);
  if (running) return running;
  const p = ensureClientInner(webId).finally(() => {
    if (globalThis.__pinionInflight?.get(webId) === p) globalThis.__pinionInflight.delete(webId);
  });
  globalThis.__pinionInflight.set(webId, p);
  return p;
}

async function ensureClientInner(webId: string): Promise<PiRpcClient> {
  const db = await getDb();
  const row = db.select().from(sessionsTable).where(eq(sessionsTable.id, webId)).get();
  if (!row) throw new Error("Session not found");

  const existing = managedMap().get(webId);
  if (existing?.client?.alive) {
    existing.lastSeen = Date.now();
    existing.lastActivity = Date.now();
    return existing.client;
  }
  existing?.detach?.();
  try {
    existing?.client?.dispose();
  } catch {
    /* noop */
  }

  if (!(await dirExists(row.cwd))) {
    throw new Error(`Working directory does not exist: ${row.cwd}`);
  }

  enforceProcessCap();

  const client = PiRpcClient.spawn({
    cwd: row.cwd,
    sessionFile: row.piSessionFile,
    name: row.name,
    provider: row.provider,
    model: row.modelId,
    thinkingLevel: row.thinkingLevel,
  });

  let emitter = existing?.emitter;
  if (!emitter) {
    emitter = new Emitter();
  }
  const detach = attachForwarding(webId, client);
  managedMap().set(webId, {
    webId,
    client,
    cwd: row.cwd,
    emitter,
    detach,
    lastSeen: Date.now(),
    busy: false,
    lastActivity: Date.now(),
    startedAt: Date.now(),
    turnStartedAt: null,
  });

  // Verify the process is usable and capture pi-assigned ids.
  const state = (await client.send({ type: "get_state" })) as RpcResponse;
  if (!state.success) {
    const msg = `pi get_state failed: ${String(state.error ?? "unknown error")}`;
    throw new Error(msg);
  }
  const data = (state.data ?? {}) as Record<string, unknown>;
  const piSessionId =
    typeof data.sessionId === "string" ? data.sessionId : row.piSessionId;
  const piSessionFile =
    typeof data.sessionFile === "string" ? data.sessionFile : row.piSessionFile;
  const thinking =
    typeof data.thinkingLevel === "string" ? data.thinkingLevel : row.thinkingLevel;
  db.update(sessionsTable)
    .set({
      piSessionId,
      piSessionFile,
      thinkingLevel: thinking,
      updatedAt: Date.now(),
    })
    .where(eq(sessionsTable.id, webId))
    .run();

  // Backfill cached messages for a resumed session (uses the fresh client
  // directly to avoid re-entering ensureClient while spawning).
  if (row.piSessionFile) {
    void fetchAndPersist(client, webId).catch(() => {});
  }

  return client;
}

export function getLiveClient(webId: string): PiRpcClient | null {
  const entry = managedMap().get(webId);
  return entry?.client?.alive ? entry.client : null;
}

/**
 * Snapshot of every live pi subprocess, joined with its session row so the UI
 * can show which project/session each one serves. Includes the shared
 * server-side metadata process (no session) when it is running.
 */
export async function listRunningProcesses(): Promise<RunningProcessInfo[]> {
  const db = await getDb();
  const rows = db.select().from(sessionsTable).all();
  const byId = new Map(rows.map((r) => [r.id, r]));

  const out: RunningProcessInfo[] = [];
  for (const entry of managedMap().values()) {
    const client = entry.client;
    if (!client?.alive) continue;
    const row = byId.get(entry.webId);
    out.push({
      sessionId: entry.webId,
      kind: "session",
      name: row?.name ?? entry.webId,
      cwd: row?.cwd ?? entry.cwd,
      pid: client.pid,
      busy: entry.busy,
      startedAt: entry.startedAt,
      lastActivity: entry.lastActivity,
    });
  }

  const global = globalThis.__pinionGlobalClient;
  if (global?.alive) {
    const startedAt = globalThis.__pinionGlobalStartedAt ?? Date.now();
    out.push({
      sessionId: null,
      kind: "server",
      name: "Server metadata",
      cwd: global.cwd,
      pid: global.pid,
      busy: false,
      startedAt,
      lastActivity: startedAt,
    });
  }

  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Stop a pi subprocess on user request. `sessionId = null` targets the shared
 * server metadata process. SIGTERM by default (pi exits gracefully); `force`
 * escalates to SIGKILL.
 *
 * Unlike `destroyClient`, the managed entry and its SSE subscribers survive, so
 * the next prompt respawns transparently — the same contract as idle reaping.
 * Returns false when nothing was running.
 */
export function stopProcess(
  sessionId: string | null,
  opts: { force?: boolean } = {},
): boolean {
  const signal = opts.force ? "SIGKILL" : "SIGTERM";

  if (sessionId === null) {
    const client = globalThis.__pinionGlobalClient;
    if (!client?.alive) return false;
    globalThis.__pinionGlobalDetach?.();
    globalThis.__pinionGlobalDetach = undefined;
    globalThis.__pinionGlobalClient = undefined;
    globalThis.__pinionGlobalStartedAt = undefined;
    try {
      client.dispose(signal);
    } catch {
      /* noop */
    }
    return true;
  }

  const entry = managedMap().get(sessionId);
  if (!entry?.client?.alive) return false;
  entry.detach?.();
  try {
    entry.client.dispose(signal);
  } catch {
    /* noop */
  }
  entry.client = null;
  entry.busy = false;
  entry.turnStartedAt = null;
  entry.detach = () => {};
  entry.emitter.emit("sse", {
    type: "client_exit",
    reason: opts.force ? "killed" : "stopped",
    signal,
  });
  console.log(`[pi] stopped (${signal}) process for session ${sessionId}`);
  return true;
}

/** Process limits shown in the UI (same source the reaper/cap use). */
export function processLimits(): ProcessLimits {
  return { maxProcesses: piMaxProcesses(), idleTimeoutMs: piIdleTimeoutMs() };
}

/**
 * Reap pi processes idle longer than PI_IDLE_TIMEOUT_MS (0 = disabled).
 * Busy (streaming/compacting) sessions are always spared. Entries and SSE
 * subscribers survive — the next use respawns transparently. Returns the
 * reaped web session ids.
 */
export function sweepIdleClients(now: number = Date.now()): string[] {
  const timeout = piIdleTimeoutMs();
  if (!(timeout > 0)) return [];
  const reaped: string[] = [];
  for (const entry of managedMap().values()) {
    if (!entry.client?.alive || entry.busy) continue;
    if (now - entry.lastActivity >= timeout) {
      reapEntry(entry, "idle");
      reaped.push(entry.webId);
    }
  }
  return reaped;
}

/** Evict LRU idle processes when over PI_MAX_PI_PROCESSES (0 = unlimited). */
function enforceProcessCap(): void {
  const max = piMaxProcesses();
  if (!(max > 0)) return;
  const alive = [...managedMap().values()].filter((e) => e.client?.alive);
  if (alive.length < max) return;
  const idle = alive
    .filter((e) => !e.busy)
    .sort((a, b) => a.lastActivity - b.lastActivity);
  let over = alive.length - max + 1; // +1 for the spawn about to happen
  for (const entry of idle) {
    if (over <= 0) break;
    reapEntry(entry, "cap");
    over--;
  }
}

function reapEntry(entry: ManagedEntry, reason: "idle" | "cap"): void {
  try {
    entry.detach();
  } catch {
    /* noop */
  }
  try {
    entry.client?.dispose();
  } catch {
    /* noop */
  }
  entry.client = null;
  entry.busy = false;
  entry.turnStartedAt = null;
  entry.detach = () => {};
  console.log(`[pi] reaped ${reason} process for session ${entry.webId}`);
}

function ensureSweeper(): void {
  if (globalThis.__pinionSweeperStarted) return;
  globalThis.__pinionSweeperStarted = true;
  const t = setInterval(() => {
    try {
      const reaped = sweepIdleClients();
      if (reaped.length) console.log(`[pi] idle sweep reaped ${reaped.length} process(es)`);
    } catch (err) {
      console.error("[pi] idle sweep failed", err);
    }
  }, 60_000);
  (t as unknown as { unref?: () => void }).unref?.();
}

export function destroyClient(webId: string): void {
  const entry = managedMap().get(webId);
  if (!entry) return;
  // Keep the SSE emitter alive briefly so the UI can observe client_exit.
  entry.detach?.();
  try {
    entry.client?.dispose();
  } catch {
    /* noop */
  }
  entry.emitter.emit("sse", { type: "client_exit", reason: "disposed" });
  managedMap().delete(webId);
}

/** Shared client (server cwd) used for metadata like model listings. */
export async function ensureGlobalClient(): Promise<PiRpcClient> {
  const cur = globalThis.__pinionGlobalClient;
  if (cur && cur.alive) return cur;
  try {
    globalThis.__pinionGlobalDetach?.();
  } catch {
    /* noop */
  }
  try {
    cur?.dispose();
  } catch {
    /* noop */
  }
  const cwd = process.env.PI_DEFAULT_CWD?.trim() || process.cwd();
  const client = PiRpcClient.spawn({ cwd, extraCliArgs: ["--no-session"] });
  globalThis.__pinionGlobalClient = client;
  globalThis.__pinionGlobalStartedAt = Date.now();
  const detach = () => {
    client.removeAllListeners();
  };
  globalThis.__pinionGlobalDetach = detach;
  await client.send({ type: "get_state" });
  return client;
}

/** Pull pi's authoritative messages via a known client and mirror into sqlite. */
export async function fetchAndPersist(client: PiRpcClient, webId: string): Promise<AgentMessage[]> {
  const res = await client.send({ type: "get_messages" });
  if (!res.success) throw new Error(String(res.error ?? "get_messages failed"));
  const list = ((res.data as { messages?: unknown })?.messages ?? []) as AgentMessage[];
  await persistMessages(webId, list);
  return list;
}

export async function syncMessagesFromPi(webId: string): Promise<AgentMessage[]> {
  const client = await ensureClient(webId);
  return fetchAndPersist(client, webId);
}

export async function persistMessages(webId: string, list: AgentMessage[]): Promise<void> {
  const db = await getDb();
  db.delete(messagesTable).where(eq(messagesTable.sessionId, webId)).run();
  if (!list.length) {
    touchSession(webId);
    return;
  }
  for (const m of list) {
    const role =
      typeof (m as { role?: unknown }).role === "string"
        ? String((m as { role?: unknown }).role)
        : "unknown";
    const ts =
      typeof (m as { timestamp?: unknown }).timestamp === "number"
        ? Number((m as { timestamp?: unknown }).timestamp)
        : Date.now();
    let contentJson = "[]";
    try {
      const c = (m as { content?: unknown }).content;
      contentJson = JSON.stringify(c ?? null).slice(0, 200_000);
    } catch {
      contentJson = "[]";
    }
    let rawJson = "{}";
    try {
      rawJson = JSON.stringify(m).slice(0, 500_000);
    } catch {
      rawJson = "{}";
    }
    db.insert(messagesTable)
      .values({ sessionId: webId, role, contentJson, rawJson, timestamp: ts })
      .run();
  }
  touchSession(webId);
}

export async function readCachedMessages(webId: string): Promise<AgentMessage[]> {
  const db = await getDb();
  const rows = db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, webId))
    .all();
  const out: AgentMessage[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.rawJson) as AgentMessage);
    } catch {
      /* skip corrupt rows */
    }
  }
  return out;
}
