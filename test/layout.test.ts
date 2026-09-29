import { describe, expect, test } from "bun:test";
import {
  MD_BREAKPOINT_PX,
  MOBILE_QUERY,
  loadCollapsedPaths,
  loadFileViewPreference,
  nextSidebarUser,
  saveCollapsedPaths,
  saveFileViewPreference,
  sidebarTranslateClass,
} from "@/lib/layout";

describe("layout breakpoints", () => {
  test("mobile query matches Tailwind's md breakpoint", () => {
    expect(MD_BREAKPOINT_PX).toBe(768);
    expect(MOBILE_QUERY).toBe("(max-width: 767px)");
  });
});

describe("sidebar visibility (hydration-safe tri-state)", () => {
  test("undecided state defers to CSS: drawer hidden on mobile, panel shown from md up", () => {
    expect(sidebarTranslateClass(null)).toBe("-translate-x-full md:translate-x-0");
  });

  test("explicit open/close wins on every breakpoint", () => {
    expect(sidebarTranslateClass(true)).toBe("translate-x-0");
    expect(sidebarTranslateClass(false)).toBe("-translate-x-full md:hidden");
  });

  test("toggle flips effective openness", () => {
    expect(nextSidebarUser(null, true)).toBe(true); // mobile default closed -> open
    expect(nextSidebarUser(null, false)).toBe(false); // desktop default open -> close
    expect(nextSidebarUser(true, true)).toBe(false);
    expect(nextSidebarUser(false, false)).toBe(true);
  });
});

describe("file-browser view preference", () => {
  test("SSR-safe: list view when localStorage is unavailable", () => {
    expect(typeof localStorage).toBe("undefined");
    expect(loadFileViewPreference()).toBe("list");
  });

  test("round-trips gallery, ignores garbage", () => {
    const store = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    try {
      saveFileViewPreference("gallery");
      expect(loadFileViewPreference()).toBe("gallery");
      saveFileViewPreference("list");
      expect(loadFileViewPreference()).toBe("list");
      store.set("pinion.files.view", "thumbnail");
      expect(loadFileViewPreference()).toBe("list");
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).localStorage;
    }
  });
});

describe("collapsed-projects persistence", () => {
  test("SSR-safe: empty set when localStorage is unavailable", () => {
    expect(typeof localStorage).toBe("undefined");
    expect(loadCollapsedPaths()).toEqual(new Set());
  });

  test("round-trips through localStorage, ignores garbage", () => {
    const store = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    try {
      expect(loadCollapsedPaths()).toEqual(new Set());
      saveCollapsedPaths(new Set(["/a", "/b"]));
      expect(loadCollapsedPaths()).toEqual(new Set(["/a", "/b"]));
      store.set("pinion.project.collapsed", "not-json{{{");
      expect(loadCollapsedPaths()).toEqual(new Set());
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).localStorage;
    }
  });
});
