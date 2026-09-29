# Contributing

Thanks for taking a look at Pinion. It is a single-user, self-hosted app, and
its behavior is covered by a Bun-native test suite — that suite is the
contract, so changes should keep it green.

## Setup

```bash
cp .env.example .env
bun install
bun run dev     # http://127.0.0.1:3000
```

Bun 1.2+ is required (the app uses `bun:sqlite`, `Bun.spawn`, `Bun.Glob`).
No `pi` binary is needed for the test suite — tests run against
`test/helpers/fake-pi.ts`, a stub RPC agent.

## Before opening a PR

```bash
bun run check   # bun test && tsc --noEmit && eslint .
```

Or individually: `bun test`, `bun run typecheck`, `bun run lint`.

`bun run build` should also stay green (it type-checks the whole app).

## Testing discipline (TDD)

This repo follows red-green-refactor:

1. Write a failing test that captures the new behavior or the reported bug,
   and watch it fail.
2. Implement the minimal change that makes it pass.
3. Refactor only while the suite stays green.

Every bug fix must land with a regression test that fails without the fix.
Never delete, skip, or weaken a failing test to make the suite pass — only
remove tests for intentionally-removed behavior, and say so in the PR.

Test isolation rules: temp `DATABASE_URL` files via `freshDb()`, unique
session ids, `destroyClient()` after each manager test. Never touch
`./data/pinion.db`, never spawn the real `pi`, never hit the network.

## Style

- Match the surrounding code; there is no formatter step, but `eslint .` must
  pass with no errors (warnings are allowed and should not grow).
- Keep server logic out of components where a pure helper can be tested
  instead (`lib/request-guard.ts` is the model for this).
- Update `README.md` and `AGENTS.md` when behavior, env vars, or file layout
  change.
