/**
 * Health + global model metadata. **Server-only**: `Bun.$` here; the browser
 * SDK calls `GET /api/health` instead of importing this module.
 */

import { $ } from "bun";
import { defaultCwd, piBinary } from "@/lib/pi/env";
import { ControlError } from "./errors";
import type { ControlDeps } from "./plane";
import type { HealthSnapshot } from "./types";

export interface HealthService {
  get(): Promise<HealthSnapshot>;
  listGlobalModels(): Promise<{ models: unknown[] }>;
}

async function piVersion(): Promise<string | null> {
  try {
    const out = await $`${piBinary()} --version`.text();
    return out.trim().slice(0, 100) || null;
  } catch {
    return null;
  }
}

export function createHealthService(deps: ControlDeps): HealthService {
  return {
    async get() {
      const version = await piVersion();
      return {
        app: "Pinion",
        piBinary: piBinary(),
        piVersion: version,
        piAvailable: version != null,
        defaultCwd: defaultCwd(),
        runtime: `bun ${Bun.version}`,
      };
    },

    async listGlobalModels() {
      // Spawns the shared metadata process (`--no-session`); never idle-reaped.
      const session = await deps.host.ensureGlobal();
      const res = await session.getAvailableModels();
      if (!res.success) {
        throw new ControlError(
          "internal",
          String(res.error ?? "failed to list models"),
          { status: 500 },
        );
      }
      return { models: ((res.data as { models?: unknown })?.models ?? []) as unknown[] };
    },
  };
}
