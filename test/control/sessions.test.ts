/**
 * Control-plane session service: reads never spawn; CRUD statuses match the
 * HTTP contract; lifecycle clone owns the sqlite dance.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { ControlError } from "@/lib/control/errors";
import { createControlPlane } from "@/lib/control";
import { destroyClient, getLiveClient, stopProcess } from "@/lib/pi/manager";
import {
  cleanupDbs,
  freshDb,
  installFakePi,
  makeTempDir,
  removeTempDir,
  uniqueId,
} from "../helpers/test-env";

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
  stopProcess(null);
  restorePi?.();
  restorePi = null;
});

afterAll(async () => {
  await cleanupDbs();
  for (const d of dirs.splice(0)) await removeTempDir(d);
});

const control = createControlPlane();

async function seedSession(cwd?: string): Promise<string> {
  let dir: string;
  if (cwd) dir = cwd;
  else {
    dir = await makeTempDir();
    dirs.push(dir);
  }
  const id = uniqueId("ctl");
  const now = Date.now();
  (await getDb())
    .insert(sessions)
    .values({ id, name: "ctl", cwd: dir, createdAt: now, updatedAt: now })
    .run();
  liveIds.push(id);
  return id;
}

describe("SessionService reads", () => {
  test("get on a sleeping session reads the cache and does not spawn", async () => {
    const id = await seedSession();
    const detail = await control.sessions.get(id);
    expect(detail.session.id).toBe(id);
    expect(detail.live).toBe(false);
    expect(detail.state).toBeNull();
    expect(detail.messages).toEqual([]);
    expect(getLiveClient(id)).toBeNull();
  });

  test("getMessages / getStats never spawn", async () => {
    const id = await seedSession();
    expect(await control.sessions.getMessages(id)).toEqual({ messages: [], live: false });
    expect(await control.sessions.getStats(id)).toEqual({
      state: null,
      stats: null,
      live: false,
    });
    expect(getLiveClient(id)).toBeNull();
  });

  test("get on a missing session is a 404 ControlError", async () => {
    const err = await control.sessions.get("missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).status).toBe(404);
  });
});

describe("SessionService CRUD", () => {
  test("create does not spawn; delete is 200 even when missing", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const { session } = await control.sessions.create({ cwd: dir, name: "made" });
    liveIds.push(session.id);
    expect(getLiveClient(session.id)).toBeNull();

    const list = await control.sessions.list();
    expect(list.sessions.some((s) => s.id === session.id)).toBe(true);

    const renamed = await control.sessions.rename(session.id, "renamed");
    expect(renamed.session.name).toBe("renamed");

    expect(await control.sessions.delete(session.id)).toEqual({ deleted: session.id });
    expect(await control.sessions.delete(session.id)).toEqual({ deleted: session.id });
  });

  test("create with a missing cwd → 400 ControlError", async () => {
    const err = await control.sessions
      .create({ cwd: "/definitely/not/here-pinion" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).status).toBe(400);
  });

  test("rename requires a name and a row", async () => {
    const id = await seedSession();
    await expect(control.sessions.rename(id, "  ")).rejects.toThrow("Name is required");
    await expect(control.sessions.rename("nope", "x")).rejects.toThrow("Session not found");
  });

  test("start spawns; missing session bubbles the ensure error", async () => {
    const id = await seedSession();
    expect(await control.sessions.start(id)).toEqual({ started: true, live: true });
    expect(getLiveClient(id)).not.toBeNull();

    await expect(control.sessions.start("nope")).rejects.toThrow("Session not found");
  });
});

describe("SessionService lifecycle", () => {
  test("clone creates a new web row, switches the original back, and does not keep the clone live", async () => {
    const id = await seedSession();
    await control.sessions.start(id);
    const srcBefore = (await getDb())
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();

    const out = await control.sessions.lifecycle(id, { op: "clone" });
    expect(out.response.success).toBe(true);
    expect(out.clonedSession).toBeDefined();
    expect(out.clonedSession!.id).not.toBe(id);
    expect(out.clonedSession!.name).toContain("(clone)");
    expect(out.clonedSession!.piSessionFile).not.toBe(srcBefore!.piSessionFile);
    liveIds.push(out.clonedSession!.id);
    expect(getLiveClient(out.clonedSession!.id)).toBeNull();

    // The original row points back at its own file after the switch-back.
    const srcAfter = (await getDb())
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    expect(srcAfter!.piSessionFile).toBe(srcBefore!.piSessionFile);
  });

  test("fork / switch_session require their ids (400)", async () => {
    const id = await seedSession();
    await control.sessions.start(id);
    await expect(control.sessions.lifecycle(id, { op: "fork" })).rejects.toThrow(
      "entryId is required",
    );
    await expect(
      control.sessions.lifecycle(id, { op: "switch_session" }),
    ).rejects.toThrow("sessionPath is required");
  });

  test("unknown op → 400", async () => {
    const id = await seedSession();
    const err = await control.sessions
      .lifecycle(id, { op: "nope" as "clone" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).status).toBe(400);
  });

  test("new_session refreshes the pi ids on the row", async () => {
    const id = await seedSession();
    await control.sessions.start(id);
    (await getDb())
      .update(sessions)
      .set({ lastTurnMs: 4321 })
      .where(eq(sessions.id, id))
      .run();
    const before = (await getDb()).select().from(sessions).where(eq(sessions.id, id)).get();
    await control.sessions.lifecycle(id, { op: "new_session" });
    const after = (await getDb()).select().from(sessions).where(eq(sessions.id, id)).get();
    expect(after!.piSessionFile).not.toBe(before!.piSessionFile);
    // A fresh conversation has no completed turn to time.
    expect(after!.lastTurnMs).toBeNull();
  });
});

describe("ProcessService", () => {
  test("list contains the started session; stop detaches but keeps the entry", async () => {
    const id = await seedSession();
    await control.sessions.start(id);
    const listed = await control.processes.list();
    expect(listed.processes.some((p) => p.sessionId === id)).toBe(true);
    expect(listed.limits.maxProcesses).toBeGreaterThan(0);

    expect(await control.processes.stop(id)).toEqual({ stopped: true });
    expect(getLiveClient(id)).toBeNull();

    // The next prompt respawns transparently.
    const res = await control.sessions.prompt(id, { message: "again" });
    expect(res.response.success).toBe(true);
    expect(getLiveClient(id)).not.toBeNull();
  });
});
