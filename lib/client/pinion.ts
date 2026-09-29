/**
 * PinionClient — the browser SDK, 1:1 with the calls the web UI makes.
 *
 * Methods throw `ClientError` on failure; the low-level `api()` helper stays
 * available for callers that prefer `{ ok, error }`.
 */

import { request, type ApiResult, type HttpClientOptions } from "./http";
import { subscribeSession } from "./stream";
import { rawFileUrl, type BrowseEntry, type FilePreviewData } from "@/lib/file-browser";
import type { GitStatusSnapshot } from "@/lib/git-status";
import type { MentionEntry } from "@/lib/file-mentions";
import type {
  AgentMessage,
  CallContext,
  CreateSessionInput,
  RpcResponse,
  DialogAnswer,
  FolderListing,
  HealthSnapshot,
  ModelListing,
  PiModel,
  ProcessLimits,
  ProjectInfo,
  PromptInput,
  RunningProcessInfo,
  SessionDetail,
  SessionEvent,
  SessionListItem,
  SessionMessagesSnapshot,
  SessionRecord,
  SessionStatsSnapshot,
  Unsubscribe,
} from "@/lib/control/types";

export interface PinionClientOptions extends HttpClientOptions {
  EventSource?: typeof EventSource;
}

export class ClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

const enc = encodeURIComponent;

export class PinionClient {
  readonly opts: PinionClientOptions;

  constructor(opts: PinionClientOptions = {}) {
    this.opts = opts;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const r: ApiResult<T> = await request<T>(path, init, this.opts);
    if (!r.ok || r.data === undefined) {
      throw new ClientError(r.error ?? "Request failed");
    }
    return r.data;
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.call(path, { method: "POST", body: JSON.stringify(body ?? {}) });
  }

  health = {
    get: (): Promise<HealthSnapshot> => this.call<HealthSnapshot>("/api/health"),
  };

  sessions = {
    list: async (): Promise<SessionListItem[]> =>
      (await this.call<{ sessions: SessionListItem[] }>("/api/sessions")).sessions,

    create: async (input: CreateSessionInput): Promise<SessionRecord> =>
      (
        await this.call<{ session: SessionRecord }>("/api/sessions", {
          method: "POST",
          body: JSON.stringify(input ?? {}),
        })
      ).session,

    get: (id: string): Promise<SessionDetail> =>
      this.call<SessionDetail>(`/api/sessions/${enc(id)}`),

    rename: async (id: string, name: string): Promise<SessionRecord> =>
      (
        await this.call<{ session: SessionRecord }>(`/api/sessions/${enc(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        })
      ).session,

    delete: async (id: string): Promise<void> => {
      await this.call(`/api/sessions/${enc(id)}`, { method: "DELETE" });
    },

    start: (id: string): Promise<{ started: boolean; live: boolean }> =>
      this.call<{ started: boolean; live: boolean }>(`/api/sessions/${enc(id)}/start`, {
        method: "POST",
      }),

    messages: (id: string): Promise<SessionMessagesSnapshot> =>
      this.call<SessionMessagesSnapshot>(`/api/sessions/${enc(id)}/messages`),

    stats: (id: string): Promise<SessionStatsSnapshot> =>
      this.call<SessionStatsSnapshot>(`/api/sessions/${enc(id)}/stats`),

    prompt: (id: string, input: PromptInput): Promise<{ response: RpcResponse }> =>
      this.call<{ response: RpcResponse }>(`/api/sessions/${enc(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      }),

    abort: (id: string): Promise<{ response: RpcResponse }> =>
      this.call<{ response: RpcResponse }>(`/api/sessions/${enc(id)}/control`, {
        method: "POST",
        body: JSON.stringify({ action: "abort" }),
      }),

    compact: (
      id: string,
      opts: { customInstructions?: string } = {},
    ): Promise<{ response: RpcResponse }> =>
      this.call<{ response: RpcResponse }>(`/api/sessions/${enc(id)}/control`, {
        method: "POST",
        body: JSON.stringify({ action: "compact", ...opts }),
      }),

    clearQueue: (id: string): Promise<unknown> =>
      this.post(`/api/sessions/${enc(id)}/control`, { action: "clear_queue" }),

    exportHtml: (id: string): Promise<unknown> =>
      this.post(`/api/sessions/${enc(id)}/control`, { action: "export_html" }),

    control: (
      id: string,
      body: { action: string } & Record<string, unknown>,
    ): Promise<{ response: RpcResponse | null; live?: boolean }> =>
      this.call<{ response: RpcResponse | null; live?: boolean }>(
        `/api/sessions/${enc(id)}/control`,
        { method: "POST", body: JSON.stringify(body) },
      ),

    bash: (id: string, command: string): Promise<{ result: unknown }> =>
      this.call<{ result: unknown }>(`/api/sessions/${enc(id)}/bash`, {
        method: "POST",
        body: JSON.stringify({ command }),
      }),

    abortBash: (id: string): Promise<{ response: RpcResponse }> =>
      this.call<{ response: RpcResponse }>(`/api/sessions/${enc(id)}/bash`, {
        method: "DELETE",
      }),

    getModel: (id: string): Promise<ModelListing> =>
      this.call<ModelListing>(`/api/sessions/${enc(id)}/model`),

    setModel: (
      id: string,
      input: { provider?: string; modelId: string; level?: string },
    ): Promise<unknown> =>
      this.post(`/api/sessions/${enc(id)}/model`, input),

    setThinkingLevel: (id: string, level: string): Promise<unknown> =>
      this.post(`/api/sessions/${enc(id)}/model`, { level }),

    lifecycle: (
      id: string,
      body: { op: string } & Record<string, unknown>,
    ): Promise<{ response: RpcResponse; clonedSession?: SessionRecord }> =>
      this.call<{ response: RpcResponse; clonedSession?: SessionRecord }>(
        `/api/sessions/${enc(id)}/lifecycle`,
        { method: "POST", body: JSON.stringify(body) },
      ),

    answerDialog: async (id: string, body: DialogAnswer): Promise<void> => {
      await this.post(`/api/sessions/${enc(id)}/extension-ui`, body);
    },

    getTree: (id: string): Promise<{ tree: unknown }> =>
      this.call<{ tree: unknown }>(`/api/sessions/${enc(id)}/tree`),

    /** In-process projected events over HTTP EventSource. */
    subscribe: (
      id: string,
      listener: (ev: SessionEvent) => void,
      opts: { onClose?: () => void } = {},
    ): Unsubscribe =>
      subscribeSession(id, listener, {
        baseUrl: this.opts.baseUrl,
        EventSource: this.opts.EventSource,
        token: this.opts.token,
        onClose: opts.onClose,
      }),
  };

  files = {
    mentions: (
      sessionId: string,
      dir: string,
    ): Promise<{ cwd: string; dir: string; entries: MentionEntry[] }> =>
      this.call(`/api/sessions/${enc(sessionId)}/files?dir=${enc(dir)}`),

    browse: (
      sessionId: string,
      dir: string,
    ): Promise<{ cwd: string; dir: string; entries: BrowseEntry[]; truncated: boolean }> =>
      this.call(`/api/sessions/${enc(sessionId)}/files/browse?dir=${enc(dir)}`),

    preview: (sessionId: string, path: string): Promise<FilePreviewData> =>
      this.call(`/api/sessions/${enc(sessionId)}/files/content?path=${enc(path)}`),

    /** Same helper as today — still an /api URL for `<img src>`. */
    rawUrl: (
      sessionId: string,
      path: string,
      opts: { download?: boolean } = {},
    ): string => rawFileUrl(sessionId, path, opts),
  };

  processes = {
    list: (): Promise<{ processes: RunningProcessInfo[]; limits: ProcessLimits }> =>
      this.call("/api/processes"),
    stop: (id: string | null, opts: { force?: boolean } = {}): Promise<{ stopped: boolean }> =>
      this.call<{ stopped: boolean }>("/api/processes/stop", {
        method: "POST",
        body: JSON.stringify({ id, ...opts }),
      }),
  };

  git = {
    /** Working-tree changes vs HEAD: files + line counts, never diff text. */
    status: (sessionId: string): Promise<GitStatusSnapshot> =>
      this.call<GitStatusSnapshot>(`/api/sessions/${enc(sessionId)}/git`),
  };

  projects = {
    list: async (): Promise<ProjectInfo[]> =>
      (await this.call<{ projects: ProjectInfo[] }>("/api/projects")).projects,
    pin: (path: string): Promise<ProjectInfo | null> =>
      this.call<{ project: ProjectInfo | null }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ path }),
      }).then((d) => d.project),
    unpin: async (path: string): Promise<ProjectInfo[]> =>
      (
        await this.call<{ projects: ProjectInfo[] }>("/api/projects", {
          method: "DELETE",
          body: JSON.stringify({ path }),
        })
      ).projects,
    listFolders: (path: string): Promise<FolderListing> =>
      this.call(`/api/projects/folders?path=${enc(path)}`),
  };
}

/** Default singleton for the web app (same-origin, HttpOnly cookie). */
export const pinion = new PinionClient();

export type { CallContext, PiModel, AgentMessage };
