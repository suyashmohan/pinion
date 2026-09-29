/**
 * Responsive layout contract (single source of truth).
 *
 * - Tailwind's `md` breakpoint (min-width 768px) is the boundary between the
 *   mobile drawer sidebar and the static desktop sidebar.
 * - CSS uses `md:` variants; JS uses `MOBILE_QUERY` with `useMediaQuery`
 *   (see hooks/useMediaQuery.ts). Keep the two in sync — covered by
 *   test/layout.test.ts.
 *
 * Hydration rule: the *initial* sidebar visibility must be identical in SSR
 * HTML and the first client render, so it is owned by CSS, not JS.
 * Components keep a tri-state (`boolean | null`, `null` = "follow the CSS
 * default") and only apply explicit open/closed classes after the user
 * interacts. Never read `window`/`localStorage`/`matchMedia` during the
 * first render — hydrate such prefs inside `useEffect`.
 */
export const MD_BREAKPOINT_PX = 768;
export const MOBILE_QUERY = "(max-width: 767px)";

const COLLAPSED_KEY = "pinion.project.collapsed";
const FILE_VIEW_KEY = "pinion.files.view";

export type FileViewPreference = "list" | "gallery";

/** Translate classes for the sidebar drawer/panel (branch-pure, SSR-safe). */
export function sidebarTranslateClass(userOpen: boolean | null): string {
  if (userOpen == null) return "-translate-x-full md:translate-x-0";
  return userOpen ? "translate-x-0" : "-translate-x-full md:hidden";
}

/**
 * Toggle helper for event handlers only (viewport is known post-mount).
 * Flips the *effective* openness: the explicit state, or the CSS default
 * (closed on mobile, open on desktop) when undecided.
 */
export function nextSidebarUser(current: boolean | null, isMobile: boolean): boolean {
  return !(current ?? !isMobile);
}

/** Which rail owns the right-side slot (or none). */
export type RightPanelKind = "files" | "git" | "closed";

/**
 * The right rail hosts either Files or Git, never both: opening one closes
 * the other, and clicking the already-open one closes the rail.
 */
export function nextRightPanel(
  current: RightPanelKind,
  which: Exclude<RightPanelKind, "closed">,
): RightPanelKind {
  return current === which ? "closed" : which;
}

/** SSR-safe: empty set when localStorage is unavailable. */
export function loadCollapsedPaths(): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function saveCollapsedPaths(paths: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...paths]));
  } catch {
    /* private mode etc. */
  }
}

/**
 * List/gallery preference for the file browser. The panel itself always
 * starts collapsed (never persisted); only the view mode is remembered.
 * SSR-safe: falls back to the list view without `localStorage`.
 */
export function loadFileViewPreference(): FileViewPreference {
  try {
    if (typeof localStorage === "undefined") return "list";
    return localStorage.getItem(FILE_VIEW_KEY) === "gallery" ? "gallery" : "list";
  } catch {
    return "list";
  }
}

export function saveFileViewPreference(view: FileViewPreference): void {
  try {
    localStorage.setItem(FILE_VIEW_KEY, view);
  } catch {
    /* private mode etc. */
  }
}
