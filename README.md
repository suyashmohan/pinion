# Pinion — Web GUI for the Pi coding agent

Single-user Next.js + Tailwind CSS v4 webapp that drives **`pi --mode rpc`**
(the Pi.dev agent's JSON-RPC mode) through a modern chat interface with dark
and light themes.

> **Security:** Pinion has no login and can run shell commands and edit files as
your user. It binds to `127.0.0.1` by default and refuses unexpected hosts and
cross-origin mutations, but anything that can reach its port has a shell on
your machine. Run it in [Docker](#docker) so that shell lives in a container
instead of your account. Do not expose it to the internet — see
[Security](#security).

## Screenshot

![Pinion showing a chat transcript next to the project sidebar, git rail and file browser](./docs/screenshot.png)

*Dark theme: project-grouped sidebar, streamed transcript with tool output, and
the right-hand rail (Files/Git).*

## Features

- **One web session = one `pi --mode rpc` subprocess** running in the session's
  working directory (where `read` / `write` / `edit` / `bash` operate).
- **Live streaming** via Server-Sent Events: text/thinking deltas, tool
  progress, queue updates, compaction + retry status, and the completed
  turn's wall time (small, muted, persisted per session) at the end of the
  transcript — it stays after a refresh.
- **Full RPC coverage**: prompt / steer / follow-up / abort / clear-queue,
  models + thinking levels, compact, bash, fork / clone / new session,
  export HTML, session tree, and the **extension UI dialog protocol**
  (`select` / `confirm` / `input` / `editor` render as modals).
- **Project-grouped sidebar**: sessions nest under their project folder
  (auto-discovered from session working directories, plus pinnable folders
  via `POST /api/projects`). Collapse state persists in localStorage.
- **Right-side file browser** (collapsed by default; Files button or
  `⌘/Ctrl+Shift+E`): one folder level at a time under the session's project,
  list or thumbnail-gallery view, image full-view lightbox, and previews for
  text/code (highlight.js syntax highlighting) and markdown (rendered GFM or
  highlighted source). Docked beside the chat from `md` up, full-screen
  takeover on phones or via the expand button.
- **Right-side git rail** (collapsed by default; Git button or
  `⌘/Ctrl+Shift+G`): working-tree changes vs HEAD — changed files with
  added/removed line counts and status badges, no diff text. Shares the file
  browser's slot (only one rail open at a time), polls while open, and says
  so plainly when the session folder is not a git repository.
- **Responsive**: mobile drawer sidebar with backdrop (< 768px), static
  sidebar on tablet/desktop, overflow (⋯) action menu in the chat header on
  mobile, fluid model-picker dropdown and toasts.
- **Persistent storage**: Drizzle ORM + SQLite (`bun:sqlite`) caches
  sessions and messages locally. Pi's own JSONL session files remain the
  source of truth; the DB is reconciled from `get_messages`.

## Getting started

Two ways to run Pinion — the [Docker](#docker) image (recommended) or
[from source](#from-source), for development or when you can't use Docker.
Both end up on `http://127.0.0.1:3000`. First, clone the repo:

```bash
git clone https://github.com/suyashmohan/pinion.git
cd pinion
```

### Docker

**This is the recommended way to run Pinion.** `pi` has full access to
everything it can reach — no permission prompts, no built-in sandbox — and
Pinion hands it a web UI. The container confines that access to the image plus
the folders you mount, so the agent can work freely on your projects without
holding the keys to the rest of the machine.

One image runs everything on Bun — the built web app and the `pi` agent:

```bash
cp -n .env.example .env   # only if you don't have one; add provider keys
docker compose up --build
# → http://127.0.0.1:3000
```

The compose file mounts:

| Mount | Container path | Purpose |
| ----- | -------------- | ------- |
| `PINION_WORKSPACE` (default `./workspace`) | `/workspace` | Project tree the agent works in; default cwd for new sessions (`PI_DEFAULT_CWD`) |
| volume `pinion-data` | `/app/data` | SQLite cache (`DATABASE_URL=file:/app/data/pinion.db`) |
| volume `pinion-agent` | `/root/.pi` | pi auth, settings, skills and session JSONL files |

Provider keys and other secrets belong in `.env` (gitignored), never in the
compose file — `docker-compose.yml` only declares which *paths* and *ports*
the container uses.

Give the agent model credentials in one of three ways:

- **Put provider keys in `.env`** (repo root, gitignored). Compose loads the
  whole file into the container via `env_file`, so keys never appear in
  `docker-compose.yml`:

  ```bash
  cp -n .env.example .env    # -n: keep your existing .env
  echo 'DEEPSEEK_API_KEY=sk-...' >> .env
  docker compose up -d
  ```

  Any provider variable from pi's `docs/providers.md` works the same way
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …).
- **Log in inside the container**: `docker compose exec pinion pi /login`
- **Reuse the host pi config** by swapping the `pinion-agent` volume for
  `${HOME}/.pi:/root/.pi`. The container then sees your host auth and sessions
  and writes new session files there — convenient, but shared state.

Without compose:

```bash
docker build -t pinion .
docker run --rm -p 127.0.0.1:3000:3000 \
  -v "$HOME/projects:/workspace" \
  -v pinion-data:/app/data \
  -v pinion-agent:/root/.pi \
  pinion
```

Notes:

- `.env` is also where `PINION_WORKSPACE`, `PINION_PORT`, `PINION_TOKEN` and
  `PINION_ALLOWED_HOSTS` can live; compose reads it for both container env and
  YAML substitution. Container paths (`DATABASE_URL`, `PI_BINARY`,
  `PI_DEFAULT_CWD`) are pinned in compose and override `.env`, so a `.env`
  written for a bare-metal run can't break the container.
- The published port is loopback-only, exactly like the bare-metal default;
  set `PINION_PORT` to publish on a different host port (e.g. `PINION_PORT=3210
  docker compose up`). For LAN access replace `127.0.0.1` with `0.0.0.0` in
  the compose `ports:` line **and** set `PINION_ALLOWED_HOSTS` (plus
  `PINION_TOKEN`) — the [Security](#security) rules are unchanged inside a
  container.
- The image pins the `pi` version (`PI_VERSION`, default `0.99.1`); rebuild
  with `--build-arg PI_VERSION=x.y.z` to move. `GET /api/health` reports the
  version actually running.
- Container processes run as `root`, so on Linux files the agent creates in a
  bind-mounted workspace are root-owned. If that matters, set
  `user: "${UID}:${GID}"` and point `PI_CODING_AGENT_DIR` at a writable
  volume.
- The container only confines what is *inside* it: anything you bind-mount
  (the default workspace, or a host `~/.pi`) is fair game for the agent. Never
  mount `$HOME`, your SSH keys, or the Docker socket.
- `tini` is the entrypoint (PID 1) to reap `pi` subprocesses and forward
  `SIGTERM` — don't add `--init` / `init: true` on top of it.

### From source

Not using the container? Then you install the pieces yourself — the
[Docker image](#docker) bundles Bun and a version-pinned `pi` already.

- Bun 1.2+ (**required** — the app uses `bun:sqlite`, `Bun.spawn`,
  `Bun.Glob` and `Bun.$`, none of which exist under Node)
- The `pi` binary on `PATH` (or set `PI_BINARY`), authenticated
  (`pi /login` or provider API keys — the webapp inherits the server env).
  Install it with:

  ```bash
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  # or: curl -fsSL https://pi.dev/install.sh | sh
  ```

  A bare-metal pi install runs on Node (its bin is `#!/usr/bin/env node`,
  `engines.node >= 22.19`). The Docker image installs pi with Bun and runs it
  on Bun (the base image's `node` is a Bun shim), so it needs no Node.js.

  Pinion talks to pi's RPC protocol and is tested against **pi 0.99.x**.
  `GET /api/health` reports the detected version — a newer major pi may need
  Pinion updates.

Then install and run the dev server:

```bash
cp .env.example .env   # adjust DATABASE_URL / PI_BINARY / PI_DEFAULT_CWD
bun install
bun run dev            # http://127.0.0.1:3000
```

The npm scripts invoke `bun --bun ...` internally, so `npm run dev` also
lands on the Bun runtime. If you bypass the scripts (e.g. `npx next dev`),
the server refuses to start with `Pinion must run on the Bun runtime`.

`dev`/`start` go through `scripts/next.ts`, which **binds to loopback by
default**. To reach the UI from a phone or another machine on your LAN:

```bash
PINION_HOST=0.0.0.0 PINION_ALLOWED_HOSTS=192.168.1.50 bun run dev
```

The address you browse from must be in `PINION_ALLOWED_HOSTS`, otherwise every
request is rejected with `403` (that is the DNS-rebinding guard). Read
[Security](#security) before doing this.

Production:

```bash
bun run build
bun run start
```

SQLite needs no separate server. The default `./data/` directory ships with
the repo; a custom `DATABASE_URL` path must already exist (the server
refuses to start with a clear error otherwise).

## Stack

- **Bun only** — the server must run on the Bun runtime (`bun --bun`).
  `bun:sqlite` cannot load under Node, so Node compatibility is intentionally
  not maintained. Running under Node fails fast with a clear error.
- Next.js (App Router) + React 19
- Tailwind CSS v4 (`@import "tailwindcss"`)
- Drizzle ORM + `bun:sqlite` (built into Bun — no native addon to compile;
  DB file in `./data/pinion.db`, WAL mode)
- `lucide-react` icons, `react-markdown` + `remark-gfm` message rendering
- `highlight.js` (core + a curated language set) for code/markdown previews

## Checks

```bash
bun test              # unit + protocol + hydration suite
bun run typecheck     # tsc --noEmit
bun run lint          # eslint (Next's flat config)
bun run check         # all three
```

Bun-native suite in `test/` (see AGENTS.md for the testing discipline):
unit tests for utils, message helpers, emitter, env parsing, files and
layout; SQLite schema tests on throwaway temp DBs; protocol and manager
integration tests against `test/helpers/fake-pi.ts`, a stub
`pi --mode rpc` agent selected via `PI_BINARY` — so no test touches real
LLMs, the network, or `./data/pinion.db`. `test/hydration.test.ts`
SSR-renders the app shell with zero browser globals, then hydrates it in
a mobile-simulated DOM (happy-dom) and fails on any React hydration
warning.

## Configuration (`.env`)

| Var | Default | Purpose |
| --- | ------- | ------- |
| `DATABASE_URL` | `file:./data/pinion.db` | SQLite file for drizzle |
| `PI_BINARY` | `pi` | Path to the pi agent binary |
| `PI_DEFAULT_CWD` | `process.cwd()` | Default tool sandbox for new sessions |
| `PI_EXTRA_ARGS` | _(empty)_ | Extra args for every `pi --mode rpc` spawn |
| `PI_RPC_TIMEOUT_MS` | `120000` | Request/response timeout |
| `PI_IDLE_TIMEOUT_MS` | `900000` (15min) | Reap unused pi processes; `0` disables |
| `PI_MAX_PI_PROCESSES` | `10` | Soft cap (LRU idle eviction); `0` = unlimited |
| `PINION_HOST` | `127.0.0.1` | Bind address; `0.0.0.0` for LAN (see Security) |
| `PINION_PORT` | `3000` (or `PORT`) | HTTP port |
| `PINION_ALLOWED_HOSTS` | _(empty)_ | Extra `Host` names accepted (LAN IP, Tailscale name) |
| `PINION_TOKEN` | _(unset)_ | Shared secret required on every request when set |
| `PINION_ALLOWED_DEV_ORIGINS` | _(empty)_ | Extra origins for Next.js dev resources (LAN HMR) |

## Security

Pinion is deliberately login-free for single-user, local use, and that shapes
the whole security model:

- **It binds to loopback by default.** `dev`/`start` pass `-H 127.0.0.1`;
  `PINION_HOST=0.0.0.0` is an explicit opt-in for LAN access.
- **Host allowlist.** `proxy.ts` rejects any request whose `Host` is not
  `localhost`/`127.0.0.1`/`[::1]` or listed in `PINION_ALLOWED_HOSTS`, which
  stops DNS rebinding (a malicious domain resolving to 127.0.0.1).
- **Same-origin mutations.** Every non-GET request must come from Pinion's own
  origin. Browsers attach `Origin`/`Sec-Fetch-Site` to cross-site requests, so
  a web page you visit cannot POST to the API — not even with the
  `no-cors` + `text/plain` trick that skips CORS preflight.
- **Optional shared token.** Setting `PINION_TOKEN` requires a cookie minted by
  opening `http://<host>:<port>/?token=YOUR_TOKEN` once. Use it when binding
  beyond loopback or fronting Pinion with a tunnel.

The logic lives in `lib/request-guard.ts` (pure and unit-tested); `proxy.ts`
is only the Next.js adapter.

**Never expose Pinion directly to the internet.** If you need remote access,
use a VPN/tunnel (Tailscale, WireGuard, SSH port-forward) or an authenticated
reverse proxy, plus `PINION_TOKEN`.

## How it works

```
Browser ──fetch/SSE──▶ Next.js API routes ──JSONL stdin/stdout──▶ pi --mode rpc
                              │
                              ▼
                     drizzle + SQLite cache
```

- `lib/pi/rpc-client.ts` — Bun-native JSONL client: `Bun.spawn` with piped
  stdio, `TextDecoder` framing (splits on LF only, strips trailing CR,
  correlates `id` → response promise), tiny local `Emitter` instead of
  `node:events`.
- `lib/files.ts` — Bun-native fs helpers (`Bun.Glob` probes for directory
  checks). `node:path` is still used for pure string path math — Bun has no
  equivalent module for that, and it runs natively under Bun.
- `lib/pi/manager.ts` — process-lifetime singleton: spawn/respawn per web
  session (concurrent spawns deduped via an in-flight map), SSE fan-out,
  `agent_settled` → `get_messages` → SQLite sync. Spawning is **lazy on user
  intent**: viewing a session reads the SQLite cache and attaches the SSE
  stream without starting pi (`live: false`); focusing the composer calls
  `POST /api/sessions/[id]/start`. Processes idle past `PI_IDLE_TIMEOUT_MS`
  are reaped and `PI_MAX_PI_PROCESSES` bounds concurrency via LRU eviction —
  streaming sessions are never touched, and respawn is transparent (SSE
  subscribers survive).
- `app/api/sessions/**` — CRUD + prompt/control/model/stats/tree/lifecycle/
  bash/extension-ui/stream endpoints. Read endpoints report `live: false` and
  never spawn; `POST /api/sessions/[id]/start` is the intent-driven spawn.
- `app/api/projects` — pinned + discovered project folders (backed by the
  `settings` table).
- `app/api/processes` — live pi subprocess inventory with the session/project
  each one serves; `POST /api/processes/stop` stops (SIGTERM) or force-kills
  (SIGKILL) one. The AppShell strip opens `ProcessPanel` to review and stop
  them; stopped sessions respawn on the next prompt.
- `lib/runtime.ts` — Bun-only guard (`assertBunRuntime`).
- `lib/request-guard.ts` + `proxy.ts` — the security boundary: Host allowlist,
  same-origin mutations, optional `PINION_TOKEN`. `proxy.ts` (Next 16's renamed
  middleware) is only an adapter so the decision logic stays unit-testable.
- `lib/net.ts` + `scripts/next.ts` — bind resolution (loopback by default)
  and the `dev`/`start` launcher that enforces it.
- `lib/layout.ts` — responsive contract (`MD_BREAKPOINT_PX`,
  `MOBILE_QUERY`, `initialSidebarOpen`; CSS `md:` variants must stay in
  sync — pinned by `test/layout.test.ts`).
- `lib/emitter.ts` — tiny event emitter used for RPC + SSE fan-out.
- `hooks/usePiSession.ts` — SSE consumer: assembles streaming text/thinking/
  tool-call drafts, holds dialogs + toasts, polls stats while streaming.
- `hooks/useProjects.ts` — project list + pin/unpin.
- `components/*` — project-grouped sidebar, chat, composer (steer/follow-up
  queueing, image attach), tool cards, model picker, extension dialogs.

### Notes

- Next.js route handlers can't hold WebSockets without a custom server, so
  agent events stream over **SSE** (`GET /api/sessions/[id]/stream`) while
  commands are plain `POST`s whose `response` resolves the HTTP call.
  The stream emits **named** events (`event: agent_start` …) — browser
  `EventSource` only delivers those to per-name `addEventListener`
  listeners, never to `onmessage`. The hook subscribes to each name
  explicitly; don't "simplify" it back to `onmessage`.
- `getDb()` is **async** (Bun's I/O APIs are async-only) — every server
  caller must `await` it. Concurrent callers share one in-flight open.
- `better-sqlite3` is gone: `bun:sqlite` is listed in no config at all — it's
  part of the runtime, so there is no `serverExternalPackages` entry and no
  postinstall compile step. The existing `data/pinion.db` file (plain SQLite)
  is reused as-is.
- If the pi process dies, the UI shows a toast; the next prompt (or focusing
  the composer) respawns it and re-attaches to the same pi session file.
  Idle processes close themselves after `PI_IDLE_TIMEOUT_MS` (default 15 min,
  `0` disables) and are respawned transparently.

## License

[MIT](LICENSE) © Suyash Mohan
