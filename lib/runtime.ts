/** Bun is the only supported runtime — `bun:sqlite` cannot load under Node. */
export const IS_BUN =
  typeof Bun !== "undefined" && typeof (Bun as { spawn?: unknown }).spawn === "function";

export function assertBunRuntime(scope: string): void {
  if (!IS_BUN) {
    throw new Error(
      `[${scope}] Pinion must run on the Bun runtime. Start it with \`bun --bun run dev\` (or \`bun --bun run start\`).`,
    );
  }
}
