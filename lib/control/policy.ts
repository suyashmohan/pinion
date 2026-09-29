/**
 * Supervisor policy: self-prompt, cycle, and fan-out guards.
 *
 * `source: "ui"` (the web app's default ctx) is allow-all — extract PRs must
 * not change web behavior. The fan-out counter is **per plane** (created by
 * `createControlPlane`), not a second process table, and only counts
 * concurrent in-flight prompts from the same supervisor session.
 */

import { ControlError } from "./errors";
import type { CallContext } from "./types";

export const DEFAULT_SUPERVISOR_FANOUT = 3;

export type MutatingKind = "prompt" | "bash" | "lifecycle";

export interface PolicyEngine {
  /** Throws when the call is not allowed. Reads the counter; does not increment. */
  assertAllowed(ctx: CallContext, targetSessionId: string, kind: MutatingKind): void;
  /**
   * Reserve an in-flight prompt slot for `ctx.fromSessionId`. No-op for
   * non-supervisor contexts. The returned release is idempotent.
   */
  acquirePrompt(ctx: CallContext): () => void;
  /** Current in-flight prompt count for one supervisor session. */
  inFlight(fromSessionId: string | undefined): number;
  readonly fanout: number;
}

function resolveFanout(): number {
  const raw = process.env.PINION_SUPERVISOR_FANOUT;
  if (raw == null || raw.trim() === "") return DEFAULT_SUPERVISOR_FANOUT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SUPERVISOR_FANOUT;
  return Math.floor(n);
}

export function createPolicyEngine(opts: { fanout?: number } = {}): PolicyEngine {
  const fanout = opts.fanout ?? resolveFanout();
  const inFlight = new Map<string, number>();

  return {
    fanout,

    assertAllowed(ctx, targetSessionId, kind) {
      if (ctx.source === "ui" || ctx.source === "system") return;
      if (ctx.fromSessionId && ctx.fromSessionId === targetSessionId) {
        throw new ControlError("forbidden", "A session cannot prompt itself", {
          status: 403,
        });
      }
      if (ctx.chain.includes(targetSessionId)) {
        throw new ControlError("forbidden", "Supervisor prompt cycle detected", {
          status: 403,
        });
      }
      if (kind !== "prompt") return;
      const from = ctx.fromSessionId;
      if (!from) return;
      if ((inFlight.get(from) ?? 0) >= fanout) {
        throw new ControlError(
          "conflict",
          `Supervisor fan-out limit reached (${fanout} concurrent prompts)`,
          { status: 409 },
        );
      }
    },

    acquirePrompt(ctx) {
      if (ctx.source !== "supervisor" || !ctx.fromSessionId) return () => {};
      const from = ctx.fromSessionId;
      inFlight.set(from, (inFlight.get(from) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (inFlight.get(from) ?? 0) - 1;
        if (next <= 0) inFlight.delete(from);
        else inFlight.set(from, next);
      };
    },

    inFlight(fromSessionId) {
      if (!fromSessionId) return 0;
      return inFlight.get(fromSessionId) ?? 0;
    },
  };
}

/** Process-wide default engine used by the `control` singleton. */
export const defaultPolicy = createPolicyEngine();

/** Convenience wrapper for callers that only need the guard. */
export function assertAllowed(
  ctx: CallContext,
  targetSessionId: string,
  kind: MutatingKind,
  engine: PolicyEngine = defaultPolicy,
): void {
  engine.assertAllowed(ctx, targetSessionId, kind);
}
