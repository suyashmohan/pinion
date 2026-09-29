import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { messages, sessions, settings } from "@/lib/db/schema";
import { cleanupDbs, freshDb, uniqueId } from "./helpers/test-env";

beforeEach(async () => {
  await freshDb();
});

afterAll(async () => {
  await cleanupDbs();
});

describe("sqlite schema (temp DB per test)", () => {
  test("creates tables and round-trips a session", async () => {
    const db = await getDb();
    const id = uniqueId("s");
    const now = Date.now();
    db.insert(sessions)
      .values({ id, name: "t", cwd: "/tmp", createdAt: now, updatedAt: now })
      .run();
    const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
    expect(row?.name).toBe("t");
    expect(row?.cwd).toBe("/tmp");
    expect(row?.lastTurnMs).toBeNull();
  });

  test("adds last_turn_ms to a database created before the column existed", async () => {
    // Existing installs were created by the `CREATE TABLE IF NOT EXISTS`
    // fallback, which cannot evolve a schema — the ALTER must be idempotent
    // and run against the user's existing data/pinion.db.
    const file = `/tmp/${uniqueId("pinion-old")}.db`;
    try {
      const old = new Database(file, { create: true });
      old.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT 'New session',
          cwd TEXT NOT NULL,
          provider TEXT,
          model_id TEXT,
          thinking_level TEXT,
          pi_session_id TEXT,
          pi_session_file TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      old.close();

      process.env.DATABASE_URL = `file:${file}`;
      const g = globalThis as unknown as Record<string, unknown>;
      g.__pinionDbPromise = undefined;
      g.__pinionSqlite = undefined;

      const db = await getDb();
      const id = uniqueId("s");
      db.insert(sessions)
        .values({ id, name: "old", cwd: "/tmp", createdAt: 1, updatedAt: 1 })
        .run();
      const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
      expect(row?.lastTurnMs).toBeNull();
    } finally {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          await $`rm -f ${file + suffix}`.quiet();
        } catch {
          /* best effort */
        }
      }
    }
  });

  test("deleting a session cascades to its messages", async () => {
    const db = await getDb();
    const id = uniqueId("s");
    const now = Date.now();
    db.insert(sessions).values({ id, name: "t", cwd: "/tmp", createdAt: now, updatedAt: now }).run();
    db.insert(messages)
      .values({ sessionId: id, role: "user", contentJson: '"hi"', rawJson: "{}", timestamp: now })
      .run();
    db.delete(sessions).where(eq(sessions.id, id)).run();
    expect(db.select().from(messages).where(eq(messages.sessionId, id)).all()).toEqual([]);
  });

  test("settings upsert overwrites (projects pin path)", async () => {
    const db = await getDb();
    const put = (v: string) =>
      db
        .insert(settings)
        .values({ key: "pinned_projects", value: v })
        .onConflictDoUpdate({ target: settings.key, set: { value: v } })
        .run();
    put('["/a"]');
    put('["/a","/b"]');
    const row = db.select().from(settings).where(eq(settings.key, "pinned_projects")).get();
    expect(row?.value).toBe('["/a","/b"]');
  });
});
