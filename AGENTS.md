<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- Pinion project rules (safe to edit — outside the Next-managed block above) -->

# Pinion — agent notes

Single-user Next.js web GUI driving `pi --mode rpc` (Pi coding agent
JSON-RPC over stdin/stdout). **Bun-only runtime**: `bun:sqlite`,
`Bun.spawn`, `Bun.Glob`, `Bun.$` — no Node compatibility. Run via
`bun run dev` / `bun run build` / `bun run start` (scripts force
`bun --bun` internally, so `npm run dev` works too). Never `npx next dev`.
`dev`/`start` go through `scripts/next.ts`, which binds **127.0.0.1 by
default** (`PINION_HOST=0.0.0.0` to opt into LAN).

## Layout

**Three layers, one direction: `lib/pi` (transport) → `lib/control`
(domain) → `app/api` + `lib/client` (adapters).**

- `lib/pi/` — transport. `rpc-client.ts` is the JSONL client on `Bun.spawn`.
  `host.ts` is the **only** module that writes pi JSONL command names
  (`prompt`, `abort`, `fork`, `sendRaw` for the `/control` catch-all); control
  talks domain methods to `AgentHost` / `AgentSession`. `types.ts` is
  transport-only (`RpcCommand`, `RpcResponse`, `PiEvent`); domain DTOs live in
  `lib/control/types.ts`.
- `lib/pi/manager.ts` — one `pi` process per web session, raw SSE fan-out,
  `ensureClient` dedupes concurrent spawns via in-flight map. Spawning is
  lazy on **user intent**: read paths (`GET /api/sessions/[id]`, `/messages`,
  `/stats`, the SSE `/stream`, read-only `/control` actions) serve cache /
  empty state with `live: false` and never spawn; the composer changing focus
  triggers `POST /api/sessions/[id]/start`. Idle processes are reaped
  (`sweepIdleClients`, 60s sweeper) and concurrency is capped
  (`enforceProcessCap`, LRU idle eviction, busy sessions spared).
  `entry.client` is nullable — reap keeps the entry and emitter so respawn
  is transparent. Each `agent_settled` persists the turn's wall time to
  `sessions.last_turn_ms` and tags the broadcast event with the same
  `durationMs`, so the transcript footer survives refresh and the live tab
  agrees with the row. **Known leaks stay locked**: `GET /model`, `GET /tree`
  and `GET /api/models` do spawn on purpose (`test/lazy-spawn.test.ts`).
- `lib/control/` — the control plane. `plane.ts` (`createControlPlane()` +
  the `control` singleton) exposes `sessions` / `processes` / `projects` /
  `health`. Services throw `ControlError` with an **explicit** `status`
  (missing session is 404 on read paths and 500 on `ensure` paths — do not
  "fix" that). `subscribeRaw` is raw `PiEvent` fan-out (SSE only);
  `subscribe` projects into snapshot `SessionEvent`s via `projector.ts`
  (one projector per subscriber; `applySessionEvent` replaces fields, never
  concatenates). `policy.ts` owns supervisor self-prompt/cycle checks and the
  per-plane fan-out counter. **Server-only barrel** — client code must import
  `@/lib/control/types` / `@/lib/control/projector`, never `@/lib/control`
  (it would bundle `bun:sqlite`).
- `lib/client/` — isomorphic UI SDK (`PinionClient`, `pinion` singleton).
  Every call the React app makes goes through it. `http.ts` resolves `fetch`
  lazily and defaults to `credentials: "include"`; `stream.ts` owns the
  `EventSource` and registers each name in `PI_SSE_EVENT_TYPES`
  (`onmessage` never fires for named SSE events). No `bun:*`, no
  `next/server`, no `@/lib/db` in here.
- Import fences are enforced twice: core `no-restricted-imports` globs in
  `eslint.config.mjs`, and `test/import-fences.test.ts` (greps the server
  barrel, `Bun.spawn`, `next/server`, hooks re-assembling `text_delta`, and
  hard-coded `/api/` URLs in chrome — `rawFileUrl` is the one exception).
  `lib/pi/process-state.ts` is a deprecated re-export of the pure helper in
  `lib/control/types.ts`.
- **Supervisor-agent doors (future MCP; do not add a third):** either
  (a) stdio **in the same OS process** as `bun run start`, importing
  `control` (bypasses Host/CSRF because it is already root-equivalent), or
  (b) a **separate** process that is a `PinionClient` against
  `http://127.0.0.1` with `Cookie: pinion_token=...`. Never import
  `createControlPlane`/manager in a second OS process (double spawn), never
  add an internal MCP HTTP route or a new listener. Policy recursion/fan-out
  lives in `lib/control/policy.ts` (`CallContext` on mutating methods;
  UI ctx is allow-all).
- **Theming** — `lib/themes.ts` (isomorphic registry: `BUILT_IN_THEMES`,
  `registerTheme`, storage + boot script) plus semantic tokens in
  `app/globals.css` (`:root` dark, `[data-theme="light"]` light) mapped to
  Tailwind via `@theme inline`. Components use **only** token utilities
  (`bg-app`, `bg-panel`, `text-fg`, `border-line`, …) — never `zinc-*`/
  `red-*` palette classes or hex (enforced by `test/theme.test.ts`). The
  active theme lives on `<html data-theme>`: the inline boot script in
  `app/layout.tsx` applies the persisted value before paint, and
  `ThemeProvider` (`components/ThemeProvider.tsx`) owns it after hydration
  (never render `data-theme` from React). `<html>` carries
  `suppressHydrationWarning` for exactly that attribute; everything below it
  hydrates strictly. New themes: a new `[data-theme="id"]` block (built-ins)
  or `registerTheme({ id, label, appearance, preview, tokens })` with
  validated `--pinion-*` overrides.
- `lib/db/` — drizzle + `bun:sqlite`. **`getDb()` is async** — always
  `await` it. Pi's JSONL files are source of truth; sqlite is a cache
  synced from `get_messages`. New nullable columns (e.g. `last_turn_ms`) need
  an idempotent `ALTER TABLE` in `lib/db/index.ts` — `CREATE TABLE IF NOT
  EXISTS` cannot evolve an existing `data/pinion.db`.
- `lib/runtime.ts` (`assertBunRuntime`), `lib/emitter.ts` (tiny emitter),
  `lib/files.ts` (`dirExists`/`hasSqlMigrations` via `Bun.Glob`).
  `node:path` is fine (string math, no Bun equivalent); no other `node:`
  imports — keep it that way.
- `proxy.ts` + `lib/request-guard.ts` — the security boundary. `proxy.ts`
  (Next 16 renamed `middleware` → `proxy`) is a **thin adapter only**; all
  decisions live in the pure, unit-tested `lib/request-guard.ts`: Host
  allowlist for every method (DNS rebinding), same-origin for non-GET
  (CSRF, incl. the `no-cors`/`text/plain` preflight bypass), optional
  `PINION_TOKEN` cookie. Keep it that way — never inline security logic in
  routes.
- `lib/net.ts` + `scripts/next.ts` — bind resolution (`DEFAULT_BIND_HOST`
  loopback) and the launcher that passes `-H`/`-p` to Next.
- `Dockerfile` + `docker-compose.yml` + `.dockerignore` — single-image
  deployment. Base: `oven/bun:1-debian` — Bun is Pinion's runtime, and Node
  (for the `pi` CLI) is copied in from `node:24-trixie-slim`; both are the
  same Debian release, so glibc matches. Stages run `bun install`,
  `bun run build`, then install `pi` globally with npm. Runner: prod-only
  `node_modules`, `.next` minus Turbopack caches, plus `scripts/` and
  `lib/net.ts` (the launcher's only import). `PINION_HOST=0.0.0.0` inside;
  compose publishes `127.0.0.1` only (`PINION_PORT` overrides the host port).
  Volumes: `/app/data` (sqlite) and `/root/.pi` (pi auth/sessions).
- `app/api/sessions/**` — session CRUD, prompt/control/model/stats/tree/
  lifecycle/bash/extension-ui/stream/export. `app/api/projects` — pinned +
  discovered project folders (stored in sqlite `settings` table).
  `app/api/processes` — live pi subprocess inventory (`GET`) + manual
  stop/kill (`POST /api/processes/stop`, SIGTERM or `force`=SIGKILL);
  `stopProcess` keeps the managed entry so the next prompt respawns
  transparently, exactly like idle reaping. Surfaced by `ProcessPanel`
  (opened from the AppShell strip).
- `app/api/sessions/[id]/files/{browse,content,raw}` — one directory level,
  text preview, and raw bytes (thumbnails, full image view, downloads) for
  the right-side file browser. `?dir=`/`?path=` are relative to the session
  cwd, guarded by `resolveWithinRoot`; `raw` never serves html/js content
  types and is CSP-sandboxed. Pure helpers in `lib/file-browser.ts`,
  highlight.js registry in `lib/highlight.ts` (only mapped languages),
  `hooks/useFileBrowser.ts`, `components/FileBrowser.tsx` +
  `FileEntries.tsx` (list/gallery) + `FilePreview.tsx` (image lightbox,
  code, markdown Rendered/Source).
- `GET /api/sessions/[id]/git` — working-tree change summary for the
  right-side git rail: change status + added/removed line counts per file,
  **no diff text**. `git` is spawned directly by the server (`lib/git.ts`,
  never pi), so opening the rail stays on the lazy-spawn-safe read path.
  Pure parsers in `lib/git-status.ts`, `hooks/useGitStatus.ts`,
  `components/GitPanel.tsx`. Files and Git share one right-side slot
  (`nextRightPanel` in `lib/layout.ts`) — identical width/placement, only
  one open at a time; `components/RightPanel.tsx` owns that shared chrome.
- `GET /api/sessions/[id]/export` — downloads the HTML export staged by
  `POST .../control { action: "export_html" }`. pi's default output path is
  the session cwd, so the control plane passes an explicit `/tmp/`
  `outputPath` (`lib/export-html.ts` owns the name/URL helpers both sides
  share). The GET is a pure read: never spawn pi on a download.
- `hooks/usePiSession.ts`, `hooks/useProjects.ts`,
  `hooks/useMediaQuery.ts`, `components/*`
  (project-grouped `Sidebar` — drawer on mobile, static from `md` up —
  `ChatView`, `Composer`, …).

## Gotchas (learned the hard way)

- Docker: `.dockerignore` must keep `.env` and `data/` out of the image
  (secrets / user state). Compose takes secrets from `.env` via `env_file`
  (`required: false`) — never add provider API keys to `docker-compose.yml`;
  container paths (`DATABASE_URL`, `PI_BINARY`, `PI_DEFAULT_CWD`) are pinned
  in `environment:`, which wins over `env_file`. `tini` is the image
  ENTRYPOINT and must stay PID 1 for `pi` subprocess reaping and `SIGTERM`
  forwarding — never also pass `--init`/`init: true`. Next-side changes only
  reach the container via `docker compose up --build`: the runner carries
  build output, not sources.

- `bun run build` forces `NODE_ENV=production`. With an ambient
  `NODE_ENV=development` Next 16.3 crashes while prerendering its internal
  `/_global-error` page (`TypeError: null is not an object (evaluating
  'k.H.useContext')`) — the build is red for environmental reasons, not code.
- After changing `lib/db/schema.ts`, **restart `bun run dev`**. The cached
  `globalThis.__pinionDbPromise` survives HMR, so the running process never
  runs the `ALTER` in `lib/db/index.ts`; worse, drizzle does not error on a
  missing column — it returns the raw column name (e.g. `lastTurnMs:
  "last_turn_ms"`), which surfaces as `Completed in —`. `bun run start`/
  `bun run build` boot fresh and migrate correctly.
- Dynamic filesystem paths in app routes trip Turbopack's "tracing the whole
  project" warning. The intentional ones (`lib/files.ts`) carry
  `path.join(/* turbopackIgnore: true */ …)`; keep it that way when adding
  new dynamic reads.
- Next 16 refuses a second `next dev` for the same project dir. E2E against
  a scratch server should use `bun run start` (production build) on a scratch
  port with a scratch `DATABASE_URL`.
- The SSE stream emits **named** events (`event: agent_start` …).
  `EventSource.onmessage` NEVER fires for those — the hook registers
  `addEventListener` per event name. Do not regress this.
- Route `params` is a `Promise` (`await params`). All API routes:
  `runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- SSR/hydration: first client render must be byte-identical to SSR HTML.
  Never read `window` / `localStorage` / `matchMedia` / `navigator` during
  render or in `useState` initializers — hydrate such prefs in `useEffect`
  (sidebar visibility is CSS-owned tri-state, collapse prefs load on
  mount; see `lib/layout.ts`). A `typeof window` branch that changes
  output is a hydration mismatch.
- `Bun.spawn` does NOT inherit post-start `process.env` mutations —
  `rpc-client.ts` passes `env: { ...process.env }` explicitly. Never rely
  on ambient env reaching pi children (this silently broke stub-controlled
  tests and would hide runtime-set provider keys).
- `better-sqlite3` is gone; `serverExternalPackages` needs no sqlite entry.
- `data/.gitkeep` keeps the default DB dir in git; custom `DATABASE_URL`
  parents must pre-exist (fail-fast by design).
- Verify with `bunx tsc --noEmit` + `bun run build`; E2E against a dev
  server on a scratch port without touching the user's sessions in
  `data/pinion.db`.
- `react-dom/client` feature-detects input-event support **at import time**.
  Importing it while no DOM exists (a static top-level import in a test file)
  silently takes the legacy path, so `input`/`change` never reach `onChange`
  for the rest of the process — every happy-dom typing test then fails. Bun
  runs test files **concurrently in one process**, so this is a race: the same
  commit passed locally and failed 15 tests on CI (run 34841998953). Always
  load it through `test/helpers/dom.ts` → `loadReactDom()` *after* installing
  a happy-dom window; `test/dom-bootstrap.test.ts` fails if a static runtime
  import comes back.
- Security regressions are silent and browser-driven. The guard is tested
  through `test/proxy.test.ts` (imports the real `proxy.ts`) and
  `test/request-guard.test.ts`; a live check is a cross-site `POST` with
  `Content-Type: text/plain` + `Origin: https://evil.example`, which must
  return 403. Do not "simplify" `readJson` to trust Content-Type or remove
  the proxy.
- `next lint` does not exist in Next 16 — `bun run lint` is `eslint .` with
  the flat config in `eslint.config.mjs`. React Compiler rules
  (`set-state-in-effect`, `preserve-manual-memoization`, `refs`) are
  warnings on purpose; `refs` false-positives on `ref={scroll.ref}`.

## Testing discipline (TDD — non-negotiable)

- Tests are Bun-native in `test/` and run with `bun test` (sub-second,
  no network, no real LLMs). Current coverage: pure units (`utils`,
  message helpers, `Emitter`, `env`, `files`, `request-guard`, `net`),
  sqlite schema behavior on temp DBs, proxy wiring/CSRF regression
  (`proxy.test.ts`), and protocol/integration tests (`rpc-client`,
  `manager`) against `test/helpers/fake-pi.ts` — an executable stub
  `pi --mode rpc` agent selected via the `PI_BINARY` env var.
  `installFakePi()` (not `useFakePi` — the name tripped
  `react-hooks/rules-of-hooks`) is the helper.
- Red-green-refactor, faithfully:
  1. Write the failing test FIRST capturing the new behavior or reported
     bug, and watch it fail.
  2. Implement the minimal change that turns it green.
  3. Refactor only while the suite stays green.
- Every bug fix lands with a regression test that fails without the fix
  (e.g. the named-SSE-events subscription is covered by the prompt
  event-order test — stream behavior must stay observable, not just
  REST-fetchable).
- Every bug REPORT starts with reproduction: write the failing test before
  touching source, watch it fail, then fix. A fix without a failing-first
  test is not done (the mobile-hydration crash is the cautionary tale —
  the suite was green because no test rendered SSR vs client output).
- Test isolation rules: temp `DATABASE_URL` files via
  `freshDb()`/`cleanupDbs()`, unique session ids, `destroyClient` after
  each manager test. Never touch `./data/pinion.db`, never spawn the real
  `pi`, never hit the network in tests.
- When adding features: extend the suite first and keep ALL existing tests
  passing. No breaking changes to established behavior without explicit
  user approval.
- Done means done: `bun test` (all green, INCLUDING
  `test/hydration.test.ts` — SSR `renderToString` with zero browser
  globals, then `hydrateRoot` in a mobile-simulated happy-dom with seeded
  `localStorage`, asserting zero hydration warnings) + `bunx tsc --noEmit`
  + `bun run lint` + `bun run build` (Next type-checks, so a red suite or
  red types is a red build). `bun run check` runs test+typecheck+lint.
  Never ship on red. Never delete, skip, or weaken a failing test
  to make the suite pass — only remove tests for intentionally-removed
  behavior, and say so explicitly.
