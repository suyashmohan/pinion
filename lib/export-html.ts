/**
 * Session HTML export staging (pure + isomorphic).
 *
 * `export_html` must be given an explicit output path: pi's default writes
 * `<cwd>/pi-session-<stamp>_<id>.html` straight into the user's project.
 * Pinion stages the transcript in the OS temp dir instead and lets the browser
 * download it from `GET /api/sessions/[id]/export`. The naming lives here so
 * the staging path (control plane) and the download URL (browser) cannot
 * drift.
 */

/** Directory exports are staged in before the browser downloads them. */
export const EXPORT_TEMP_DIR = "/tmp";

/** Every staged export file starts with this prefix. */
export const EXPORT_FILE_PREFIX = "pinion-export-";

/** A session id can only ever produce this file-name-safe segment. */
function safeSegment(sessionId: string): string {
  // `/` (and `\`) become `-`, which is safe even when a hostile id is all
  // dots: the slash is what could escape `/tmp`, never a dot after the
  // `pinion-export-` prefix. Nanoid ids may start/end with `-`/`_` — keep them
  // verbatim so two live sessions cannot collide on one staged file.
  const cleaned = sessionId.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned || "session";
}

/** Deterministic staged file name for one session. */
export function exportFileName(sessionId: string): string {
  return `${EXPORT_FILE_PREFIX}${safeSegment(sessionId)}.html`;
}

/** Absolute path of the staged export for one session. */
export function exportTempPath(sessionId: string): string {
  return `${EXPORT_TEMP_DIR}/${exportFileName(sessionId)}`;
}

/** Same-origin URL the browser downloads the staged export from. */
export function exportDownloadUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/export`;
}
