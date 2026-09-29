/**
 * Sidebar folder picker — real DOM interaction tests.
 *
 * The picker is attached to the "Add project folder" input: a small folder
 * button opens a list of *directories only* for the current path, clicking a
 * folder walks into it (the input mirrors the browsed path), and the up
 * affordance moves one level to the parent. Escape closes without clearing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { loadReactDom } from "./helpers/dom";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLTextAreaElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  "Text",
  "Comment",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "InputEvent",
  "fetch",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

const savedGlobals = new Map<string, unknown>();

function installDom(): Window {
  const win = new Window({ width: 1024, height: 768, url: "http://localhost:3000/" });
  const g = globalThis as unknown as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) {
    if (!savedGlobals.has(k)) savedGlobals.set(k, g[k]);
    g[k] = k === "window" ? win : k === "document" ? w.document : k === "navigator" ? w.navigator : w[k];
  }
  return win;
}

function restoreDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of savedGlobals) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  savedGlobals.clear();
}

interface Fixture {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

const TREE: Record<string, Fixture> = {
  "": {
    path: "/home/user",
    parent: "/home",
    entries: [
      { name: "projects", path: "/home/user/projects" },
      { name: "work", path: "/home/user/work" },
    ],
  },
  "/home/user": {
    path: "/home/user",
    parent: "/home",
    entries: [
      { name: "projects", path: "/home/user/projects" },
      { name: "work", path: "/home/user/work" },
    ],
  },
  "/home/user/projects": {
    path: "/home/user/projects",
    parent: "/home/user",
    entries: [{ name: "pinion", path: "/home/user/projects/pinion" }],
  },
  "/home/user/projects/pinion": { path: "/home/user/projects/pinion", parent: "/home/user/projects", entries: [] },
  "/home": { path: "/home", parent: "/", entries: [{ name: "user", path: "/home/user" }] },
  "/": { path: "/", parent: null, entries: [] },
};

interface Harness {
  win: Window;
  container: HTMLElement;
  requestedPaths: string[];
  input: HTMLInputElement;
  open: () => Promise<void>;
  clickFolder: (path: string) => Promise<void>;
  clickUp: () => Promise<void>;
  keydown: (el: Element, key: string) => Promise<void>;
  settle: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function mount(initialValue = "/home/user"): Promise<Harness> {
  const win = installDom();
  const g = globalThis as unknown as Record<string, unknown>;
  const requestedPaths: string[] = [];
  g.fetch = (async (input: unknown) => {
    const url = new URL(String((input as { url?: unknown })?.url ?? input), "http://localhost:3000");
    const asked = url.searchParams.get("path") ?? "";
    requestedPaths.push(asked);
    const fixture = TREE[asked] ?? { path: asked || "/", parent: null, entries: [] };
    return new Response(JSON.stringify({ ok: true, data: fixture }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const { createRoot } = await loadReactDom();
  const { FolderPicker } = await import("@/components/FolderPicker");

  function Wrapper() {
    const [value, setValue] = useState(initialValue);
    return createElement(FolderPicker, { value, onChange: setValue });
  }

  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(createElement(Wrapper));
  });

  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const clickEl = async (selector: string) => {
    const el = container.querySelector(selector) as unknown as HTMLElement | null;
    if (!el) throw new Error(`missing ${selector}`);
    await act(async () => {
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    await settle();
  };

  return {
    win,
    container: container as unknown as HTMLElement,
    requestedPaths,
    input: container.querySelector("input") as unknown as HTMLInputElement,
    open: () => clickEl('[data-testid="folder-picker-toggle"]'),
    clickFolder: (p) => clickEl(`[data-folder-path="${p}"]`),
    clickUp: () => clickEl('[data-testid="folder-picker-up"]'),
    keydown: async (el, key) => {
      await act(async () => {
        el.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
      });
      await settle();
    },
    settle,
    dispose: async () => {
      await act(async () => {
        root?.unmount();
      });
      try {
        await win.happyDOM.close();
      } catch {
        /* ignore */
      }
      restoreDom();
    },
  };
}

function panel(h: Harness): Element | null {
  return h.container.querySelector('[data-testid="folder-picker-panel"]');
}

beforeEach(() => {
  restoreDom();
});

afterEach(() => {
  restoreDom();
});

describe("FolderPicker", () => {
  test("the folder icon lists only directories for the current path", async () => {
    const h = await mount();
    try {
      expect(panel(h)).toBeNull();
      await h.open();
      expect(h.requestedPaths).toContain("/home/user");
      expect(panel(h)).not.toBeNull();
      const text = panel(h)!.textContent ?? "";
      expect(text).toContain("projects");
      expect(text).toContain("work");
      expect(h.container.querySelector('[data-folder-path="/home/user/projects"]')).not.toBeNull();
    } finally {
      await h.dispose();
    }
  });

  test("clicking a folder walks into it and the input mirrors the path", async () => {
    const h = await mount();
    try {
      await h.open();
      await h.clickFolder("/home/user/projects");
      expect(h.input.value).toBe("/home/user/projects");
      expect(h.requestedPaths).toContain("/home/user/projects");
      expect(panel(h)!.textContent).toContain("pinion");
      expect(panel(h)!.textContent).not.toContain("work");
    } finally {
      await h.dispose();
    }
  });

  test("the up affordance moves one level to the parent", async () => {
    const h = await mount("/home/user/projects");
    try {
      await h.open();
      await h.clickUp();
      expect(h.input.value).toBe("/home/user");
      expect(h.requestedPaths).toContain("/home/user");
      expect(panel(h)!.textContent).toContain("work");
    } finally {
      await h.dispose();
    }
  });

  test("Escape closes the picker and keeps the typed path", async () => {
    const h = await mount("/home/user/work");
    try {
      await h.open();
      expect(panel(h)).not.toBeNull();
      await h.keydown(h.input, "Escape");
      expect(panel(h)).toBeNull();
      expect(h.input.value).toBe("/home/user/work");
    } finally {
      await h.dispose();
    }
  });

  test("an empty input opens on the default folder and adopts it", async () => {
    const h = await mount("");
    try {
      await h.open();
      expect(h.requestedPaths).toContain("");
      expect(h.input.value).toBe("/home/user");
      expect(panel(h)!.textContent).toContain("projects");
    } finally {
      await h.dispose();
    }
  });
});
