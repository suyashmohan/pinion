import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import {
  destroyClient,
  ensureClient,
  ensureGlobalClient,
  listRunningProcesses,
  readCachedMessages,
  stopProcess,
  subscribe,
  sweepIdleClients,
  syncMessagesFromPi,
} from "@/lib/pi/manager";
import type { PiEvent } from "@/lib/pi/types";
import {
  cleanupDbs,
  freshDb,
  makeTempDir,
  removeTempDir,
  uniqueId,
  installFakePi,
} from "./helpers/test-env";

const dirs: string[] = [];
const liveIds: string[] = [];
let restorePi: (() => void) | null = null;

beforeEach(async () => {
  await freshDb();
  restorePi?.();
  restorePi = installFakePi();
});

afterEach(() => {
  for (const id of liveIds.splice(0)) destroyClient(id);
  stopProcess(null); // never leak the shared metadata process across tests
  restorePi?.();
  restorePi = null;
});

afterAll(async () => {
  await cleanupDbs();
  for (const d of dirs.splice(0)) await removeTempDir(d);
});

async function makeRow(cwd?: string): Promise<{ id: string; cwd: string }> {
  let dir: string;
  if (cwd) {
    dir = cwd;
  } else {
    dir = await makeTempDir();
    dirs.push(dir);
  }
  const id = uniqueId("web");
  const now = Date.now();
  (await getDb())
    .insert(sessions)
    .values({ id, name: "mtest", cwd: dir, createdAt: now, updatedAt: now })
    .run();
  liveIds.push(id);
  return { id, cwd: dir };
}

async function waitFor(id: string, type: string, ms = 15_000): Promise<PiEvent> {
  return new Promise<PiEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${type}`));
    }, ms);
    const off = subscribe(id, (ev) => {
      if (String(ev.type) === type) {
        clearTimeout(timer);
        off();
        resolve(ev);
      }
    });
  });
}

describe("manager with fake-pi", () => {
  test("ensureClient spawns pi and records pi session ids", async () => {
    const { id } = await makeRow();
    const client = await ensureClient(id);
    expect(client.alive).toBe(true);
    // Second call reuses the live client (no duplicate spawn).
    expect(await ensureClient(id)).toBe(client);
    const row = (await getDb()).select().from(sessions).where(eq(sessions.id, id)).get();
    expect(row?.piSessionId).toBe("fake-pi-session");
    expect(row?.piSessionFile).toContain("fake-pi-session");
  });

  test("prompt round-trips, broadcasts settle, and caches messages", async () => {
    const { id } = await makeRow();
    const client = await ensureClient(id);
    const settled = waitFor(id, "agent_settled");
    const res = await client.send({ type: "prompt", message: "hello" });
    expect(res.success).toBe(true);
    await settled;
    const msgs = await syncMessagesFromPi(id);
    expect(msgs.map((m) => (m as { role?: string }).role)).toEqual(["user", "assistant"]);
    const cached = await readCachedMessages(id);
    expect(cached).toHaveLength(2);
  });

  test("persists the completed turn's wall time and tags the settle event", async () => {
    process.env.FAKE_PI_SLOW_TURN_MS = "300";
    try {
      const { id } = await makeRow();
      const client = await ensureClient(id);
      const settled = waitFor(id, "agent_settled");
      await client.send({ type: "prompt", message: "slow" });
      const ev = await settled;

      // The live SSE event carries the same number that gets persisted, so a
      // page refresh cannot disagree with what the open tab already showed.
      expect(typeof ev.durationMs).toBe("number");
      expect(Number(ev.durationMs)).toBeGreaterThanOrEqual(250);

      // The DB write is fire-and-forget after settle — poll briefly.
      let row = (await getDb()).select().from(sessions).where(eq(sessions.id, id)).get();
      for (let i = 0; row?.lastTurnMs == null && i < 100; i++) {
        await Bun.sleep(10);
        row = (await getDb()).select().from(sessions).where(eq(sessions.id, id)).get();
      }
      expect(row?.lastTurnMs).toBe(Number(ev.durationMs));
    } finally {
      delete process.env.FAKE_PI_SLOW_TURN_MS;
    }
  }, 20_000);

  test("missing working directory throws instead of spawning", async () => {
    const { id } = await makeRow("/nope-missing-dir-pinion-xyz");
    await expect(ensureClient(id)).rejects.toThrow("does not exist");
  });
});

describe("process inventory and manual stop", () => {
  test("lists a running session process with its project, name, pid and state", async () => {
    const { id, cwd } = await makeRow();
    const client = await ensureClient(id);

    const mine = (await listRunningProcesses()).find((p) => p.sessionId === id);
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("session");
    expect(mine!.name).toBe("mtest");
    expect(mine!.cwd).toBe(cwd);
    expect(mine!.pid).toBe(client.pid);
    expect(mine!.pid).toBeGreaterThan(0);
    expect(mine!.busy).toBe(false);
  });

  test("marks a working session as busy", async () => {
    process.env.FAKE_PI_SLOW_TURN_MS = "600";
    try {
      const { id } = await makeRow();
      const client = await ensureClient(id);
      const started = waitFor(id, "agent_start");
      void client.send({ type: "prompt", message: "slow" });
      await started;

      const mine = (await listRunningProcesses()).find((p) => p.sessionId === id);
      expect(mine!.busy).toBe(true);
      await waitFor(id, "agent_settled");
    } finally {
      delete process.env.FAKE_PI_SLOW_TURN_MS;
    }
  }, 20_000);

  test("omits sessions that were never spawned", async () => {
    const { id } = await makeRow();
    expect((await listRunningProcesses()).some((p) => p.sessionId === id)).toBe(false);
  });

  test("stop terminates the process but the session respawns transparently", async () => {
    const { id } = await makeRow();
    const client = await ensureClient(id);
    const exited = waitFor(id, "client_exit");

    expect(stopProcess(id)).toBe(true);
    expect((await exited).reason).toBe("stopped");
    expect(client.alive).toBe(false);
    expect((await listRunningProcesses()).some((p) => p.sessionId === id)).toBe(false);

    // Same contract as idle reaping: entry + SSE subscribers survive, so the
    // next prompt spawns a fresh process and live events keep flowing.
    const settled = waitFor(id, "agent_settled");
    const again = await ensureClient(id);
    expect(again.alive).toBe(true);
    expect(again).not.toBe(client);
    await again.send({ type: "prompt", message: "back" });
    await settled;
  });

  test("force kill stops the process; stopping nothing reports false", async () => {
    const { id } = await makeRow();
    expect(stopProcess(id)).toBe(false);

    const client = await ensureClient(id);
    expect(stopProcess(id, { force: true })).toBe(true);
    expect(client.alive).toBe(false);
    expect(stopProcess(id)).toBe(false);
  });

  test("lists and stops the shared server metadata process", async () => {
    const { id } = await makeRow();
    await ensureClient(id);
    const server = await ensureGlobalClient();

    const listed = (await listRunningProcesses()).find((p) => p.kind === "server");
    expect(listed).toBeDefined();
    expect(listed!.sessionId).toBeNull();
    expect(listed!.pid).toBe(server.pid);

    expect(stopProcess(null)).toBe(true);
    expect(server.alive).toBe(false);
    expect((await listRunningProcesses()).some((p) => p.kind === "server")).toBe(false);
  });
});

describe("idle reaping and process cap", () => {
  test("reaps idle processes and respawns transparently", async () => {
    process.env.PI_IDLE_TIMEOUT_MS = "120";
    try {
      const { id } = await makeRow();
      const first = await ensureClient(id);
      expect(first.alive).toBe(true);
      await new Promise((r) => setTimeout(r, 220));
      expect(sweepIdleClients()).toContain(id);
      expect(first.alive).toBe(false);
      // The subscription entry survives: events flow after respawn.
      const settled = waitFor(id, "agent_settled");
      const second = await ensureClient(id);
      expect(second.alive).toBe(true);
      expect(second).not.toBe(first);
      await second.send({ type: "prompt", message: "wake" });
      await settled;
    } finally {
      delete process.env.PI_IDLE_TIMEOUT_MS;
    }
  });

  test("does not reap a streaming session", async () => {
    process.env.PI_IDLE_TIMEOUT_MS = "1";
    process.env.FAKE_PI_SLOW_TURN_MS = "1200";
    try {
      const { id } = await makeRow();
      const client = await ensureClient(id);
      const started = waitFor(id, "agent_start");
      await client.send({ type: "prompt", message: "slow" });
      await started;
      expect(sweepIdleClients()).not.toContain(id);
      expect(client.alive).toBe(true);
      await waitFor(id, "agent_settled");
      await new Promise((r) => setTimeout(r, 60));
      expect(sweepIdleClients()).toContain(id);
    } finally {
      delete process.env.PI_IDLE_TIMEOUT_MS;
      delete process.env.FAKE_PI_SLOW_TURN_MS;
    }
  }, 20_000);

  test("caps concurrent processes with LRU eviction", async () => {
    process.env.PI_MAX_PI_PROCESSES = "2";
    try {
      const a = await makeRow();
      await new Promise((r) => setTimeout(r, 30));
      const b = await makeRow();
      await new Promise((r) => setTimeout(r, 30));
      const c = await makeRow();
      const ca = await ensureClient(a.id);
      await new Promise((r) => setTimeout(r, 30));
      const cb = await ensureClient(b.id);
      await new Promise((r) => setTimeout(r, 30));
      const cc = await ensureClient(c.id);
      expect(cc.alive).toBe(true);
      expect(ca.alive).toBe(false); // LRU idle evicted
      expect(cb.alive).toBe(true);
      // Evicted sessions stay usable (respawn, evicting next-LRU).
      expect((await ensureClient(a.id)).alive).toBe(true);
    } finally {
      delete process.env.PI_MAX_PI_PROCESSES;
    }
  });

  test("cap never evicts a streaming session", async () => {
    process.env.PI_MAX_PI_PROCESSES = "1";
    process.env.FAKE_PI_SLOW_TURN_MS = "900";
    try {
      const a = await makeRow();
      const b = await makeRow();
      const ca = await ensureClient(a.id);
      const started = waitFor(a.id, "agent_start");
      await ca.send({ type: "prompt", message: "slow" });
      await started;
      const cb = await ensureClient(b.id);
      expect(cb.alive).toBe(true);
      expect(ca.alive).toBe(true); // busy: spared, cap exceeded instead
      await waitFor(a.id, "agent_settled");
    } finally {
      delete process.env.PI_MAX_PI_PROCESSES;
      delete process.env.FAKE_PI_SLOW_TURN_MS;
    }
  }, 20_000);
});
