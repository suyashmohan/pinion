import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import path from "node:path";
import * as schema from "./schema";
import { hasSqlMigrations } from "../files";
import { assertBunRuntime } from "../runtime";

// `node:path` is pure string math with no Bun equivalent — it runs natively
// under Bun. All actual I/O in this file goes through Bun APIs.

function resolveDbFile(): string {
  const raw = process.env.DATABASE_URL ?? "file:./data/pinion.db";
  const file = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  // `turbopackIgnore` opts out of the build-time filesystem tracer: the DB
  // path is runtime config, not something to bundle (see AGENTS.md).
  return path.isAbsolute(file)
    ? file
    : path.join(/* turbopackIgnore: true */ process.cwd(), file);
}

declare global {
  var __pinionDbPromise: Promise<BunSQLiteDatabase<typeof schema>> | undefined;
  var __pinionSqlite: Database | undefined;
}

async function createDb(): Promise<BunSQLiteDatabase<typeof schema>> {
  assertBunRuntime("db");
  const file = resolveDbFile();
  // `bun:sqlite` creates the file itself but not missing parent folders.
  // The default `./data/` ships with a `.gitkeep`, so this only triggers for
  // custom DATABASE_URL paths — fail with a helpful message instead of a
  // cryptic SQLiteError.
  let sqlite: Database;
  try {
    sqlite = new Database(file, { create: true });
  } catch {
    throw new Error(
      `[db] Cannot open SQLite database at "${file}". Create its parent directory first or point DATABASE_URL somewhere writable.`,
    );
  }
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });

  // Lightweight auto-migration: create tables if they don't exist.
  // We use `drizzle/` migrations when present, otherwise fall back to DDL.
  const migrationsDir = path.join(process.cwd(), "drizzle");
  try {
    if (await hasSqlMigrations(migrationsDir)) {
      migrate(db, { migrationsFolder: migrationsDir });
    } else {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT 'New session',
          cwd TEXT NOT NULL,
          provider TEXT,
          model_id TEXT,
          thinking_level TEXT,
          pi_session_id TEXT,
          pi_session_file TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_turn_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content_json TEXT NOT NULL DEFAULT '[]',
          raw_json TEXT NOT NULL DEFAULT '{}',
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
  } catch (err) {
    console.error("[db] migration failed", err);
  }

  // Lightweight schema evolution: `CREATE TABLE IF NOT EXISTS` cannot add
  // columns to a database created by an older build, so new columns need an
  // explicit idempotent ALTER (the user's data/pinion.db predates them).
  try {
    const columns = new Set(
      (
        sqlite.query("PRAGMA table_info(sessions)").all() as Array<{ name?: unknown }>
      ).map((r) => String(r.name ?? "")),
    );
    if (!columns.has("last_turn_ms")) {
      sqlite.exec("ALTER TABLE sessions ADD COLUMN last_turn_ms INTEGER");
    }
  } catch (err) {
    console.error("[db] column migration failed", err);
  }

  globalThis.__pinionSqlite = sqlite;
  return db;
}

/**
 * Async because Bun's I/O APIs are async. Concurrent callers share one
 * in-flight open; a failed open is forgotten so the next call retries.
 */
export function getDb(): Promise<BunSQLiteDatabase<typeof schema>> {
  if (!globalThis.__pinionDbPromise) {
    globalThis.__pinionDbPromise = createDb().catch((err) => {
      globalThis.__pinionDbPromise = undefined;
      throw err;
    });
  }
  return globalThis.__pinionDbPromise;
}
