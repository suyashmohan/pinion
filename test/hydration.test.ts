/**
 * Hydration regression tests (happy-dom + React hydrateRoot).
 *
 * Why this exists: `bun test` runs without a DOM, so SSR-vs-first-client-
 * render divergence is invisible to every other gate (tsc, build, SSR curl).
 * The mobile-drawer hydration crash shipped exactly because of that blind
 * spot. These tests close it: SSR-render to string with NO browser globals
 * (true SSR conditions), then hydrate inside a mobile-simulated DOM and
 * fail on any React hydration warning.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { renderToString } from "react-dom/server";
import type { hydrateRoot } from "react-dom/client";
import { loadReactDom } from "./helpers/dom";
import { Window } from "happy-dom";
import { AppShell } from "@/components/AppShell";
import { FileBrowser } from "@/components/FileBrowser";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "@/lib/themes";
import type { BrowseEntry } from "@/lib/file-browser";

const HYDRATION_ENTRIES: BrowseEntry[] = [
  {
    name: "pic.png",
    path: "images/pic.png",
    type: "file",
    kind: "image",
    size: 2048,
    mtimeMs: 1_700_000_000_000,
    language: null,
    mime: "image/png",
  },
  {
    name: "README.md",
    path: "README.md",
    type: "file",
    kind: "markdown",
    size: 32,
    mtimeMs: 1_700_000_000_000,
    language: "markdown",
    mime: null,
  },
];

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const GLobalsToClean = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Comment",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
];

function clearDomGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of GLobalsToClean) delete g[k];
  delete g.fetch;
}

function installMobileDom(seedCollapsed: string[]): Window {
  const win = new Window({ width: 390, height: 844, url: "http://localhost:3000/" });
  // Deterministic viewport: mobile matches, desktop doesn't.
  const mm = (query: string) => {
    const m = /max-width:\s*(\d+)px/.exec(query);
    const matches = m ? win.innerWidth <= Number(m[1]) : false;
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    };
  };
  (win as unknown as Record<string, unknown>).matchMedia = mm;
  win.localStorage.setItem("pinion.project.collapsed", JSON.stringify(seedCollapsed));

  const g = globalThis as unknown as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  g.window = win;
  g.document = w.document;
  g.navigator = w.navigator;
  for (const k of [
    "HTMLElement",
    "Element",
    "Node",
    "Text",
    "Comment",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "localStorage",
  ]) {
    g[k] = w[k];
  }
  // Offline API stubs so mount effects resolve without a server.
  const routes: Record<string, unknown> = {
    "/api/sessions": { sessions: [] },
    "/api/health": { defaultCwd: "/tmp", piVersion: "0.0.0-test", piAvailable: true },
    "/api/projects": { projects: [] },
    "/api/sessions/s1/files/browse": {
      cwd: "/proj",
      dir: "",
      entries: HYDRATION_ENTRIES,
      truncated: false,
    },
  };
  g.fetch = (async (input: unknown) => {
    const url = String((input as { url?: unknown })?.url ?? input);
    const pathname = new URL(url, "http://localhost:3000").pathname;
    return new Response(JSON.stringify({ ok: true, data: routes[pathname] ?? {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return win;
}

let captured: string[] = [];
let origConsoleError: typeof console.error | null = null;

function startCapture(): void {
  captured = [];
  origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
}

function stopCapture(): string[] {
  if (origConsoleError) console.error = origConsoleError;
  origConsoleError = null;
  return captured;
}

beforeEach(() => {
  clearDomGlobals();
});

afterEach(async () => {
  stopCapture();
  const g = globalThis as unknown as Record<string, unknown>;
  const win = g.window as unknown as { happyDOM?: { close?: () => Promise<void> } } | undefined;
  try {
    await win?.happyDOM?.close?.();
  } catch {
    /* ignore */
  }
  clearDomGlobals();
});

describe("AppShell hydration", () => {
  test("mobile viewport hydrates with zero hydration warnings", async () => {
    // 1. True SSR: no browser globals at all.
    clearDomGlobals();
    const ssr = renderToString(createElement(AppShell));
    expect(ssr).toContain("<aside");

    // 2. Mobile client: 390px viewport + pre-collapsed project in storage
    //    (the exact conditions of the shipped hydration crash).
    const win = installMobileDom(["/some/project"]);
    const doc = win.document;
    const container = doc.createElement("div");
    container.innerHTML = ssr;
    doc.body.appendChild(container);

    startCapture();
    let root: ReturnType<typeof hydrateRoot> | null = null;
    const reactDom = await loadReactDom();
    await act(async () => {
      // happy-dom elements are structurally compatible at runtime.
      root = reactDom.hydrateRoot(container as unknown as Element, createElement(AppShell));
    });
    const errors = stopCapture();
    await act(async () => {
      root?.unmount();
    });

    const hydrationErrors = errors.filter((e) => /hydrat/i.test(e));
    expect(hydrationErrors).toEqual([]);
  }, 30_000);

  test("file browser hydrates its persisted gallery view without warnings", async () => {
    const props = {
      sessionId: "s1",
      cwd: "/proj",
      mode: "docked" as const,
      onClose: () => {},
      onCollapse: () => {},
      onExpand: () => {},
    };
    clearDomGlobals();
    // SSR has no localStorage: the list view is the only safe initial render.
    const ssr = renderToString(createElement(FileBrowser, props));
    expect(ssr).toContain('aria-label="File browser"');

    const win = installMobileDom([]);
    // The persisted preference must be applied *after* mount, or the first
    // client render (list) would diverge from SSR and hydration would warn.
    win.localStorage.setItem("pinion.files.view", "gallery");
    const doc = win.document as unknown as Document;
    const container = doc.createElement("div");
    container.innerHTML = ssr;
    doc.body.appendChild(container);

    startCapture();
    let root: ReturnType<typeof hydrateRoot> | null = null;
    const reactDom = await loadReactDom();
    await act(async () => {
      root = reactDom.hydrateRoot(container as unknown as Element, createElement(FileBrowser, props));
    });
    await act(async () => {}); // flush the browse fetch + preference effect
    const errors = stopCapture();

    expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
    expect(doc.body.innerHTML).toContain("pic.png");
    expect(doc.body.innerHTML).toContain("images%2Fpic.png"); // gallery thumbnails

    await act(async () => {
      root?.unmount();
    });
  }, 30_000);

  test("a persisted light theme hydrates without warnings and applies after mount", async () => {
    // SSR has no localStorage: both server and first client render use the
    // default theme. The stored preference is applied in an effect (the boot
    // script in app/layout.tsx paints it before hydration in the real app).
    clearDomGlobals();
    const ssr = renderToString(createElement(AppShell));
    expect(ssr).toContain("<aside");

    const win = installMobileDom([]);
    win.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const doc = win.document as unknown as Document;
    const container = doc.createElement("div");
    container.innerHTML = ssr;
    doc.body.appendChild(container);

    startCapture();
    let root: ReturnType<typeof hydrateRoot> | null = null;
    const reactDom = await loadReactDom();
    await act(async () => {
      root = reactDom.hydrateRoot(container as unknown as Element, createElement(AppShell));
    });
    await act(async () => {}); // flush the theme effect
    const errors = stopCapture();

    expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
    expect(doc.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");

    await act(async () => {
      root?.unmount();
    });
  }, 30_000);
});
