/**
 * Theme registry (isomorphic — safe for client components and tests).
 *
 * A theme is **data**: an id + label + preview swatches, and (for custom themes)
 * a token map. The built-in themes' token values live in `app/globals.css`
 * (`:root` = dark, `[data-theme="light"]` = light) so the boot script can apply
 * the persisted theme before first paint; `THEME_TOKEN_NAMES` is the contract
 * between this module and the stylesheet (asserted in `test/theme.test.ts`).
 *
 * Adding a theme later (a settings page, DB-backed themes) means one of:
 *   1. a new `[data-theme="id"]` block in globals.css, or
 *   2. `registerTheme({ id, label, appearance, preview, tokens })` where
 *      `tokens` is a partial `--pinion-*` map applied inline at runtime.
 */

export type ThemeAppearance = "dark" | "light";

export interface ThemePreview {
  app: string;
  panel: string;
  fg: string;
  accent: string;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  appearance: ThemeAppearance;
  /** Swatch colors for pickers/previews (not the full token set). */
  preview: ThemePreview;
  /** Optional `--pinion-*` overrides for runtime-registered themes. */
  tokens?: Record<string, string>;
}

/** Sets on `<html>`; the stylesheet switches token blocks on this attribute. */
export const THEME_ATTRIBUTE = "data-theme";
export const THEME_STORAGE_KEY = "pinion.theme";
export const DEFAULT_THEME_ID = "dark";

export const DARK_THEME: ThemeDefinition = {
  id: "dark",
  label: "Dark",
  appearance: "dark",
  preview: { app: "#09090b", panel: "#18181b", fg: "#f4f4f5", accent: "#a5b4fc" },
};

export const LIGHT_THEME: ThemeDefinition = {
  id: "light",
  label: "Light",
  appearance: "light",
  preview: { app: "#f4f4f5", panel: "#ffffff", fg: "#18181b", accent: "#4338ca" },
};

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [DARK_THEME, LIGHT_THEME];

/**
 * Every raw token a theme must define. `app/globals.css` must define exactly
 * these in both `:root` and `[data-theme="light"]` (test/theme.test.ts).
 */
export const THEME_TOKEN_NAMES = [
  // surfaces
  "--pinion-app",
  "--pinion-panel",
  "--pinion-raised",
  "--pinion-active",
  // lines
  "--pinion-line",
  "--pinion-line-strong",
  "--pinion-line-focus",
  // text
  "--pinion-fg",
  "--pinion-fg-secondary",
  "--pinion-fg-muted",
  "--pinion-fg-subtle",
  "--pinion-fg-faint",
  // inverted/primary button
  "--pinion-primary",
  "--pinion-primary-fg",
  "--pinion-primary-hover",
  // accents
  "--pinion-accent",
  "--pinion-accent-2",
  "--pinion-info",
  "--pinion-success",
  "--pinion-warning",
  "--pinion-warning-soft",
  "--pinion-warning-surface",
  "--pinion-danger",
  "--pinion-danger-soft",
  "--pinion-danger-surface",
  // misc
  "--pinion-overlay",
  "--pinion-shadow-color",
  // code / syntax
  "--pinion-code-bg",
  "--pinion-code-fg",
  "--pinion-code-comment",
  "--pinion-code-keyword",
  "--pinion-code-string",
  "--pinion-code-number",
  "--pinion-code-title",
  "--pinion-code-type",
  "--pinion-code-attr",
  "--pinion-code-deleted",
] as const;

const customThemes = new Map<string, ThemeDefinition>();

/** Built-ins plus runtime-registered themes, in registration order. */
export function listThemes(): ThemeDefinition[] {
  return [...BUILT_IN_THEMES, ...customThemes.values()];
}

export function isThemeId(id: unknown): id is string {
  return typeof id === "string" && listThemes().some((t) => t.id === id);
}

export function themeById(id: string | null | undefined): ThemeDefinition {
  return listThemes().find((t) => t.id === id) ?? DARK_THEME;
}

/** Cycle order for a one-click toggle button. */
export function nextThemeId(current: string | null | undefined): string {
  const themes = listThemes();
  const i = themes.findIndex((t) => t.id === current);
  if (i === -1) return DEFAULT_THEME_ID;
  return themes[(i + 1) % themes.length]!.id;
}

/**
 * Register a runtime theme (a future "create a theme" surface calls this).
 * Built-in ids are reserved; the id must be a slug so it can be a storage value.
 */
export function registerTheme(theme: ThemeDefinition): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(theme.id)) {
    throw new Error(`Invalid theme id: ${theme.id}`);
  }
  if (BUILT_IN_THEMES.some((t) => t.id === theme.id) || customThemes.has(theme.id)) {
    throw new Error(`Theme already registered: ${theme.id}`);
  }
  if (!theme.label.trim()) throw new Error("Theme label is required");
  customThemes.set(theme.id, theme);
}

export function unregisterTheme(id: string): boolean {
  if (BUILT_IN_THEMES.some((t) => t.id === id)) return false;
  return customThemes.delete(id);
}

// ---------------------------------------------------------------------------
// Persistence (SSR-safe: storage is opted in / feature-detected)
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredTheme(storage: StorageLike | null = defaultStorage()): string {
  if (!storage) return DEFAULT_THEME_ID;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function writeStoredTheme(id: string, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* storage may be blocked (private mode) — the in-memory theme still works */
  }
}

/** Inline blocking script for the root layout: no flash of the wrong theme. */
export function themeBootScript(): string {
  const themeColors = Object.fromEntries(listThemes().map((t) => [t.id, t.preview.app]));
  return (
    `(function(){try{` +
    `var colors=${JSON.stringify(themeColors)};` +
    `var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
    `if(!t)return;` +
    `document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t);` +
    `var c=colors[t];if(!c)return;` +
    `var meta=document.querySelector('meta[name="theme-color"]');` +
    `if(!meta){meta=document.createElement('meta');meta.setAttribute('name','theme-color');document.head.appendChild(meta);}` +
    `meta.setAttribute('content',c);` +
    `}catch(err){}})();`
  );
}

// ---------------------------------------------------------------------------
// Applying a theme
// ---------------------------------------------------------------------------

export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
    colorScheme?: string;
  };
}

/** Conservative: theme values are single CSS color-ish values, nothing else. */
const SAFE_TOKEN_VALUE = /^[#a-zA-Z0-9(),.%\s-]+$/;

/** Apply `--pinion-*` overrides for a runtime-registered theme (validated). */
export function applyThemeTokens(
  el: Pick<ThemeRoot, "style">,
  tokens: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(tokens)) {
    if (!(THEME_TOKEN_NAMES as readonly string[]).includes(name)) continue;
    if (typeof value !== "string" || !SAFE_TOKEN_VALUE.test(value)) continue;
    el.style.setProperty(name, value);
  }
}

function defaultRoot(): ThemeRoot | null {
  if (typeof document === "undefined") return null;
  return document.documentElement as unknown as ThemeRoot;
}

/** Keep the browser chrome (mobile address bar) in sync with the theme. */
function applyThemeColorMeta(theme: ThemeDefinition): void {
  if (typeof document === "undefined") return;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", theme.preview.app);
}

/**
 * Set `data-theme` on the root element and apply custom tokens if the theme
 * has any. Built-in themes need no inline tokens (globals.css owns them);
 * switching away from a custom theme clears its overrides.
 */
export function applyTheme(id: string, root: ThemeRoot | null = defaultRoot()): ThemeDefinition {
  const theme = themeById(id);
  applyThemeColorMeta(theme);
  if (!root) return theme;
  root.setAttribute(THEME_ATTRIBUTE, theme.id);
  for (const name of THEME_TOKEN_NAMES) root.style.removeProperty(name);
  if (theme.tokens) applyThemeTokens(root, theme.tokens);
  root.style.colorScheme = theme.appearance;
  return theme;
}
