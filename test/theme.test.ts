/**
 * Theme system: registry, storage, boot script, token parity with globals.css,
 * and a hard guard that components only use semantic tokens (so a new theme is
 * just a token map — no component edits).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  THEME_TOKEN_NAMES,
  applyThemeTokens,
  isThemeId,
  listThemes,
  nextThemeId,
  readStoredTheme,
  registerTheme,
  themeBootScript,
  themeById,
  unregisterTheme,
  writeStoredTheme,
} from "@/lib/themes";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    map,
  };
}

afterEach(() => {
  for (const t of listThemes()) {
    if (!BUILT_IN_THEMES.some((b) => b.id === t.id)) unregisterTheme(t.id);
  }
});

describe("theme registry", () => {
  test("ships dark + light with metadata and preview swatches", () => {
    expect(BUILT_IN_THEMES.map((t) => t.id)).toEqual(["dark", "light"]);
    expect(DEFAULT_THEME_ID).toBe("dark");
    for (const t of BUILT_IN_THEMES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(["dark", "light"]).toContain(t.appearance);
      for (const c of Object.values(t.preview)) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.tokens).toBeUndefined(); // built-ins live in CSS
    }
  });

  test("themeById falls back to the default for unknown ids", () => {
    expect(themeById("light").id).toBe("light");
    expect(themeById("nope").id).toBe(DEFAULT_THEME_ID);
    expect(themeById(null).id).toBe(DEFAULT_THEME_ID);
  });

  test("nextThemeId cycles through the list", () => {
    expect(nextThemeId("dark")).toBe("light");
    expect(nextThemeId("light")).toBe("dark");
    expect(nextThemeId("nope")).toBe("dark");
  });

  test("custom themes are registerable (the future 'create a theme' path)", () => {
    registerTheme({
      id: "ocean",
      label: "Ocean",
      appearance: "dark",
      preview: { app: "#001122", panel: "#112233", fg: "#eeefff", accent: "#00aaff" },
      tokens: { "--pinion-app": "#001122", "--pinion-accent": "#00aaff" },
    });
    expect(isThemeId("ocean")).toBe(true);
    expect(themeById("ocean").label).toBe("Ocean");
    expect(nextThemeId("light")).toBe("ocean");
    expect(unregisterTheme("ocean")).toBe(true);
    expect(isThemeId("ocean")).toBe(false);
  });

  test("registerTheme rejects duplicates and built-in overrides", () => {
    expect(() =>
      registerTheme({
        id: "dark",
        label: "Fake",
        appearance: "dark",
        preview: { app: "#000", panel: "#111", fg: "#fff", accent: "#fff" },
      }),
    ).toThrow();
  });
});

describe("theme persistence", () => {
  test("read/write round-trips through a Storage-like object", () => {
    const storage = fakeStorage();
    expect(readStoredTheme(storage)).toBe(DEFAULT_THEME_ID);
    writeStoredTheme("light", storage);
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredTheme(storage)).toBe("light");
  });

  test("unknown or broken storage falls back to the default", () => {
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "wat" }))).toBe(DEFAULT_THEME_ID);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredTheme(throwing)).toBe(DEFAULT_THEME_ID);
    expect(() => writeStoredTheme("light", throwing)).not.toThrow();
  });

  test("boot script reads the stored theme before paint", () => {
    const script = themeBootScript();
    expect(script).toContain(THEME_STORAGE_KEY);
    expect(script).toContain(THEME_ATTRIBUTE);
    expect(script).toContain("try");
  });
});

describe("custom theme tokens", () => {
  function fakeEl() {
    const props = new Map<string, string>();
    return {
      style: {
        setProperty: (n: string, v: string) => {
          props.set(n, v);
        },
        removeProperty: (n: string) => {
          props.delete(n);
        },
      },
      props,
    };
  }

  test("only known tokens with bounded values are applied", () => {
    const el = fakeEl();
    applyThemeTokens(el, {
      "--pinion-app": "#123456",
      "--pinion-accent": "red; background: url(evil)",
      "--not-a-token": "#fff",
    });
    expect(el.props.get("--pinion-app")).toBe("#123456");
    expect(el.props.has("--pinion-accent")).toBe(false);
    expect(el.props.has("--not-a-token")).toBe(false);
  });
});

describe("globals.css token contract", () => {
  async function cssTokens(selector: string): Promise<Set<string>> {
    const css = await Bun.file("app/globals.css").text();
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    // naive brace matching is enough for the flat token blocks
    const end = css.indexOf("\n}", open);
    const block = css.slice(open, end);
    return new Set([...block.matchAll(/(--pinion-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
  }

  test("every token is defined for both built-in themes", async () => {
    const root = await cssTokens(":root {");
    const light = await cssTokens('[data-theme="light"] {');
    expect([...root].sort()).toEqual([...THEME_TOKEN_NAMES].sort());
    expect([...light].sort()).toEqual([...THEME_TOKEN_NAMES].sort());
  });

  test("every Tailwind token mapping points at a known raw token", async () => {
    const css = await Bun.file("app/globals.css").text();
    const mappings = [...css.matchAll(/--color-([a-z0-9-]+):\s*var\((--pinion-[a-z0-9-]+)\)/g)];
    expect(mappings.length).toBeGreaterThan(10);
    for (const [, , raw] of mappings) {
      expect(THEME_TOKEN_NAMES as readonly string[]).toContain(raw!);
    }
  });
});

describe("theme menu", () => {
  test("lists every registered theme and marks the active one", async () => {
    const { createElement } = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { ThemeList } = await import("@/components/ThemeMenu");

    const html = renderToString(
      createElement(ThemeList, { active: "light", onSelect: () => {} }),
    );
    expect(html).toContain("Dark");
    expect(html).toContain("Light");
    expect((html.match(/role="menuitemradio"/g) ?? []).length).toBe(BUILT_IN_THEMES.length);
    expect(html).toMatch(/aria-checked="true"[^>]*>[\s\S]*?Light/);
  });
});

describe("no hard-coded palette colors in UI code", () => {
  const PALETTES =
    /(?:zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/;

  async function filesUnder(globs: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const glob of globs) {
      for await (const rel of new Bun.Glob(glob).scan({ cwd: process.cwd(), dot: false })) {
        out.push(rel);
      }
    }
    return out;
  }

  test("components/hooks use semantic tokens only", async () => {
    const bad: string[] = [];
    for (const rel of await filesUnder([
      "components/**/*.tsx",
      "hooks/**/*.{ts,tsx}",
      "app/**/*.tsx",
    ])) {
      const text = await Bun.file(rel).text();
      if (PALETTES.test(text)) bad.push(rel);
      if (/\b(?:bg|text|border)-(?:black|white)\b/.test(text)) bad.push(rel);
      if (/#[0-9a-fA-F]{6}\b/.test(text)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});
