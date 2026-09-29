/**
 * Legacy fetch helper. Absorbed by `@/lib/client` (http.ts / pinion.ts) during
 * the control-plane extraction; kept as a one-line re-export so older imports
 * keep compiling.
 */
export { api, request, type ApiResult, type HttpClientOptions } from "./client/http";
export type { ProjectInfo as ProjectListItem, SessionListItem } from "./control/types";
