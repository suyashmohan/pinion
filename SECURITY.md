# Security

## Threat model (read this first)

Pinion is a single-user, self-hosted tool. By design it has **no login** and it
can execute shell commands and read/write files **as the user running the
server** — that is what makes it useful. Treat anything that can reach its
port as equivalent to a shell on that machine.

The app is built with that assumption:

- It binds to `127.0.0.1` (loopback only) unless you set `PINION_HOST`.
- Every request must carry an expected `Host` header (loopback by default,
  plus `PINION_ALLOWED_HOSTS`). This blocks DNS-rebinding attacks.
- State-changing requests must be same-origin, so a random web page cannot
  drive the API from your browser (CSRF), including `no-cors`/`text/plain`
  POSTs that skip CORS preflight.
- `PINION_TOKEN` optionally requires a shared secret cookie on every request
  for deployments that are reachable beyond localhost.

Do **not** expose Pinion to the public internet. If you need remote access,
put it behind an authenticated reverse proxy, a VPN, or a tunnel such as
Tailscale, and set `PINION_TOKEN`.

## Agent tooling (future MCP)

There is no MCP server yet. If one is added it must use exactly one of these
two doors:

1. **stdio, in the same OS process** as `bun run start`, importing the
   in-process control plane. The caller is already on the machine, so it is
   root-equivalent and bypasses Host/CSRF — it must never be exposed over TCP.
2. **A separate process using the loopback HTTP API** with
   `Cookie: pinion_token=...` (the same `PINION_TOKEN` boundary as a browser).

An internal MCP HTTP route, a new listener, or a second process manager is
forbidden. The same caveats as the UI apply to agent tools: `files.*` and the
folder picker list/read the whole filesystem, and `bash` is a shell.


## Supported versions

Only the latest commit on `main` is supported. This is a 0.x project; breaking
changes can land at any time.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repo's Security tab) rather than in a public
issue. Include reproduction steps and the affected commit. You can expect an
initial response within a few days.
