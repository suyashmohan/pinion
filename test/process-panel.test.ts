/**
 * Running-processes panel.
 *
 * The panel is the user-facing half of the process inventory: every live pi
 * subprocess must show which project and session it belongs to, whether it is
 * working, and offer Stop (SIGTERM) / Kill (SIGKILL). Server-rendered here so
 * the markup contract is testable without a browser.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppShell } from "@/components/AppShell";
import { ProcessPanel } from "@/components/ProcessPanel";
import type { ProcessLimits, RunningProcessInfo } from "@/lib/control/types";

const now = Date.now();

const SESSION_PROC: RunningProcessInfo = {
  sessionId: "web-1",
  kind: "session",
  name: "Refactor auth",
  cwd: "/Users/me/code/alpha",
  pid: 4242,
  busy: true,
  startedAt: now - 120_000,
  lastActivity: now,
};

const IDLE_PROC: RunningProcessInfo = {
  sessionId: "web-2",
  kind: "session",
  name: "Docs pass",
  cwd: "/Users/me/code/beta",
  pid: 5151,
  busy: false,
  startedAt: now - 30_000,
  lastActivity: now - 25_000,
};

const SERVER_PROC: RunningProcessInfo = {
  sessionId: null,
  kind: "server",
  name: "Server metadata",
  cwd: "/Users/me/pinion",
  pid: 99,
  busy: false,
  startedAt: now - 5_000,
  lastActivity: now - 5_000,
};

const LIMITS: ProcessLimits = { maxProcesses: 10, idleTimeoutMs: 15 * 60_000 };

function render(processes: RunningProcessInfo[] = [SESSION_PROC, IDLE_PROC, SERVER_PROC]) {
  return renderToString(
    createElement(ProcessPanel, {
      processes,
      limits: LIMITS,
      onStop: () => {},
      onRefresh: () => {},
      onClose: () => {},
    }),
  );
}

describe("ProcessPanel", () => {
  test("shows session name, project, cwd, pid and work state", () => {
    const html = render();

    expect(html).toContain("Refactor auth");
    expect(html).toContain("alpha"); // project folder
    expect(html).toContain("/Users/me/code/alpha"); // full working dir
    expect(html).toContain("4242"); // pid
    expect(html).toContain("working"); // busy session
    expect(html).toContain("idle"); // inactive session
    expect(html).toContain("Docs pass");
    expect(html).toContain("beta");
    expect(html).toContain("5151");
  });

  test("offers stop and force-kill for every process", () => {
    const html = render();
    const stops = html.match(/>Stop</g) ?? [];
    const kills = html.match(/>Kill</g) ?? [];
    expect(stops.length).toBe(3);
    expect(kills.length).toBe(3);
  });

  test("labels the session-less server process", () => {
    const html = render();
    expect(html).toContain("Server metadata");
    expect(html).toContain("server"); // badge, so it isn't mistaken for a session
  });

  test("states the idle reaping policy", () => {
    const html = render();
    expect(html).toContain("15m");
  });

  test("empty inventory renders an explicit empty state", () => {
    const html = render([]);
    expect(html).toContain("No pi processes running");
    expect(html).not.toContain(">Stop<");
  });
});

describe("AppShell process entry point", () => {
  test("the top strip exposes the running-processes panel", () => {
    // SSR has no live processes, so only the trigger button is asserted here.
    const html = renderToString(createElement(AppShell));
    expect(html).toContain("Running pi processes");
  });
});
