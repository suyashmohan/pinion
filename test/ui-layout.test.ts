/**
 * Visual-layout regression tests.
 *
 * Bun tests run without a paint engine, so these guard the *mechanism* of
 * two shipped visual bugs (reproduced with headless Chrome screenshots):
 *
 * 1. The model dropdown looked translucent over a chat because every
 *    message row is `.fade-up` — `animation-fill-mode: both` keeps the
 *    final `transform: translateY(0)` applied, which makes each message a
 *    z-index:0 stacking context painted *after* the header in document
 *    order. The header has `backdrop-blur` (a stacking context too), so its
 *    `z-50` dropdown is trapped and message text paints over it. The header
 *    must own a positive z-index (below the mobile drawer scrim, z-30).
 *
 * 2. The active project card and the active session card underneath it
 *    rendered flush against each other (two rounded bordered boxes welded
 *    together). The session list needs a top gap.
 *
 * 3. The docked file browser was wide enough (`md:340px` / `lg:400px`) that the
 *    chat column got squeezed and its header wrapped into extra bands. The
 *    docked rail must stay narrow; the conversation owns the width.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ChatView } from "@/components/ChatView";
import { FileBrowser } from "@/components/FileBrowser";
import { Sidebar } from "@/components/Sidebar";
import type { ProjectListItem, SessionListItem } from "@/lib/client-api";

function attrsOf(html: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b([^>]*)>`).exec(html);
  if (!m) throw new Error(`no <${tag}> in rendered output`);
  return m[1];
}

function classOf(attrs: string): string {
  return /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
}

function zIndexValue(classList: string): number {
  const m = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(classList);
  if (!m) return 0;
  return Number(m[1] ?? m[2]);
}

describe("chat header stacking (model dropdown legibility)", () => {
  test("header outranks the z-index:0 message layer but sits under the mobile drawer scrim", () => {
    const html = renderToString(
      createElement(ChatView, {
        sessionId: "session-1",
        onRenamed: () => {},
        onSessionCloned: () => {},
      }),
    );
    const classes = classOf(attrsOf(html, "header"));
    expect(classes).toContain("relative");
    const z = zIndexValue(classes);
    expect(z).toBeGreaterThan(0); // above .fade-up message rows (z-index: 0)
    expect(z).toBeLessThan(30); // below the drawer scrim (z-30) and modals
  });
});

describe("sidebar project/session nesting", () => {
  const now = Date.now();
  const project: ProjectListItem = {
    path: "/tmp/pinion-ui/proj",
    name: "proj",
    pinned: true,
    missing: false,
    sessionCount: 1,
    updatedAt: now,
  };
  const session: SessionListItem = {
    id: "session-1",
    name: "Header layout tweaks",
    cwd: project.path,
    provider: null,
    modelId: null,
    thinkingLevel: null,
    piSessionId: null,
    piSessionFile: null,
    createdAt: now,
    updatedAt: now,
    lastTurnMs: null,
    preview: "hello",
    messageCount: 2,
  };

  function render(): string {
    return renderToString(
      createElement(Sidebar, {
        sessions: [session],
        projects: [project],
        activeId: session.id,
        open: null,
        onClose: () => {},
        onSelect: () => {},
        onNew: () => {},
        onNewInProject: () => {},
        onDelete: () => {},
        onPinProject: async () => null,
        onUnpinProject: () => {},
      }),
    );
  }

  test("the session list is spaced away from the project row above it", () => {
    const container = /<div class="([^"]*ml-\[17px\][^"]*)"/.exec(render());
    expect(container).not.toBeNull();
    const classes = container![1];
    expect(classes).toContain("border-l");
    const mt = /(?:^|\s)mt-(?:\[(\d+(?:\.\d+)?)px\]|(\d+(?:\.\d+)?))(?:\s|$)/.exec(classes);
    expect(mt).not.toBeNull();
    const px = mt![1] ? Number(mt![1]) : Number(mt![2]) * 4; // Tailwind spacing unit
    expect(px).toBeGreaterThanOrEqual(4);
  });
});

describe("docked file browser width", () => {
  /** Fixed panel width at a breakpoint, in CSS px. */
  function widthAt(classes: string, prefix: string): number {
    const m = new RegExp(`(?:^|\\s)${prefix}:w-\\[(\\d+)px\\]`).exec(classes);
    if (!m) throw new Error(`no ${prefix} width in ${classes}`);
    return Number(m[1]);
  }

  test("stays a narrow rail so the chat column keeps its width", () => {
    const html = renderToString(
      createElement(FileBrowser, {
        sessionId: "s1",
        cwd: "/tmp/project",
        mode: "docked" as const,
        onClose: () => {},
        onCollapse: () => {},
        onExpand: () => {},
      }),
    );
    const aside = /<aside[^>]*class="([^"]*)"/.exec(html);
    expect(aside).not.toBeNull();
    const classes = aside![1];
    expect(widthAt(classes, "md")).toBeLessThanOrEqual(320);
    expect(widthAt(classes, "lg")).toBeLessThanOrEqual(360);
  });
});
