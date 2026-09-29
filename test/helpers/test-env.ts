import { $ } from "bun";
import { getDb } from "@/lib/db";

const createdDbs: string[] = [];

export function uniqueId(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Point DATABASE_URL at a fresh temp file and (re)create the schema there.
 * Never touches the real ./data/pinion.db.
 */
export async function freshDb(): Promise<string> {
  const file = `/tmp/${uniqueId("pinion-test")}.db`;
  process.env.DATABASE_URL = `file:${file}`;
  const g = globalThis as unknown as Record<string, unknown>;
  g.__pinionDbPromise = undefined;
  g.__pinionSqlite = undefined;
  createdDbs.push(file);
  await getDb();
  return file;
}

export async function cleanupDbs(): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  g.__pinionDbPromise = undefined;
  g.__pinionSqlite = undefined;
  delete process.env.DATABASE_URL;
  for (const file of createdDbs.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        await $`rm -f ${file + suffix}`.quiet();
      } catch {
        /* best effort */
      }
    }
  }
}

const FAKE_PI = new URL("./fake-pi.ts", import.meta.url).pathname;

/**
 * Route PiRpcClient at the fake-pi stub. Returns a restore function.
 * Extra env (e.g. FAKE_PI_CRLF) is applied for the duration.
 */
export function installFakePi(extraEnv: Record<string, string> = {}): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["PI_BINARY", ...Object.keys(extraEnv)]) saved[key] = process.env[key];
  process.env.PI_BINARY = FAKE_PI;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export async function makeTempDir(): Promise<string> {
  const dir = `/tmp/${uniqueId("pinion-dir")}`;
  await $`mkdir -p ${dir}`.quiet();
  return dir;
}

export async function removeTempDir(dir: string): Promise<void> {
  try {
    await $`rm -rf ${dir}`.quiet();
  } catch {
    /* best effort */
  }
}
