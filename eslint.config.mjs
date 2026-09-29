import next from "eslint-config-next";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...next,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "drizzle/**",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
    ],
  },
  {
    rules: {
      // Next 16's preset turns on React Compiler-oriented rules that flag
      // patterns this app relies on. They are downgraded to warnings (visible,
      // but not CI-failing) rather than disabled outright:
      //  - set-state-in-effect: client components fetch their data on mount
      //  - preserve-manual-memoization: compiler bail-out notices (Composer)
      //  - refs: false positive on `ref={scroll.ref}` — that passes a ref to
      //    the ref prop, it does not dereference it during render
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/refs": "warn",
    },
  },

  // ---------------------------------------------------------------------
  // Control-plane import fences (core no-restricted-imports — no plugin).
  // The matching grep test lives in test/import-fences.test.ts.
  // ---------------------------------------------------------------------
  {
    name: "pinion/ui-fence",
    files: [
      "components/**/*.{ts,tsx}",
      "hooks/**/*.{ts,tsx}",
      "app/page.tsx",
      "app/layout.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/control", message: "Client code must not import the server barrel (bun:sqlite). Use @/lib/control/types, @/lib/control/projector or @/lib/client." },
            { name: "@/lib/control/health", message: "health.ts is server-only (Bun.$); call GET /api/health via @/lib/client." },
            { name: "@/lib/pi/manager", message: "UI code talks to the control plane via @/lib/client." },
            { name: "@/lib/pi/rpc-client", message: "UI code talks to the control plane via @/lib/client." },
            { name: "@/lib/pi/host", message: "UI code talks to the control plane via @/lib/client." },
            { name: "@/lib/pi/env", message: "UI code talks to the control plane via @/lib/client." },
            { name: "@/lib/db", message: "The browser must not reach sqlite." },
          ],
        },
      ],
    },
  },
  {
    name: "pinion/api-fence",
    files: ["app/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/pi/manager", message: "Routes go through @/lib/control (SSE uses control.sessions.subscribeRaw)." },
            { name: "@/lib/pi/rpc-client", message: "Routes go through @/lib/control." },
            { name: "@/lib/pi/host", message: "Routes go through @/lib/control." },
          ],
        },
      ],
    },
  },
  {
    name: "pinion/client-fence",
    files: ["lib/client/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/db", message: "lib/client is bundled for the browser." },
            { name: "@/lib/pi/manager", message: "lib/client is bundled for the browser." },
            { name: "@/lib/pi/rpc-client", message: "lib/client is bundled for the browser." },
            { name: "@/lib/control/health", message: "health.ts is server-only." },
            { name: "next/server", message: "lib/client is bundled for the browser." },
          ],
          patterns: [
            { group: ["bun", "bun:*"], message: "lib/client is bundled for the browser." },
          ],
        },
      ],
    },
  },
  {
    name: "pinion/control-isomorphic-fence",
    files: ["lib/control/types.ts", "lib/control/projector.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/pi/manager", message: "types/projector are isomorphic." },
            { name: "react", message: "types/projector must stay framework-free." },
            { name: "react-dom", message: "types/projector must stay framework-free." },
            { name: "next/server", message: "types/projector are isomorphic." },
          ],
          patterns: [
            { group: ["bun", "bun:*"], message: "types/projector are isomorphic." },
            { group: ["next", "next/*"], message: "types/projector are isomorphic." },
          ],
        },
      ],
    },
  },
  {
    name: "pinion/control-server-fence",
    files: ["lib/control/**/*.ts"],
    ignores: ["lib/control/types.ts", "lib/control/projector.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/pi/rpc-client", message: "Control uses AgentHost methods, never PiRpcClient." },
          ],
          patterns: [
            { group: ["react", "react-dom", "@/app/*"], message: "lib/control is server-side domain code." },
          ],
        },
      ],
    },
  },
  {
    name: "pinion/transport-fence",
    files: ["lib/pi/manager.ts", "lib/pi/host.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/control", message: "Transport may only `import type` from @/lib/control/types." },
            { name: "react", message: "Transport is framework-free." },
          ],
          patterns: [{ group: ["next", "next/*"], message: "Transport is framework-free." }],
        },
      ],
    },
  },
];
