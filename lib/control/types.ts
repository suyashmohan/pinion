/**
 * Isomorphic control-plane DTOs.
 *
 * This module is imported by the React app (via `@/lib/control/types`) and by
 * the server control plane. It must stay free of `bun:*`, `next/*`, `react`
 * and process-management imports — importing the server barrel
 * (`@/lib/control`) from a client component would drag `bun:sqlite` into the
 * browser bundle.
 *
 * The transport types (`RpcCommand`, `RpcResponse`, `PiEvent`) stay in
 * `@/lib/pi/types`; they are imported here as types only.
 */

// ---------------------------------------------------------------------------
// Transport types (type-only re-export so client code has one import source).
// ---------------------------------------------------------------------------

export type { PiEvent, RpcCommand, RpcResponse } from "@/lib/pi/types";

// ---------------------------------------------------------------------------
// Transcript (pi-shaped messages — this is the product's own model, not a
// generic multi-agent block model).
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | Array<{ type: string; [k: string]: unknown }>;
  timestamp: number;
  attachments?: unknown[];
}

export interface AssistantMessage {
  role: "assistant";
  /**
   * Synthetic identity of the in-flight streamed draft (set by
   * `streamingAssistantMessage`). Real pi messages have no id; the draft has no
   * stable timestamp either — it's rebuilt for every streamed delta — so this
   * is what React keys on to avoid remounting the active row per token.
   */
  id?: string;
  content: AssistantContent[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  usage?: Usage;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string | null;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | (Record<string, unknown> & { role: string });

/** Stable id for the assistant draft that is still streaming. */
export const STREAMING_MESSAGE_ID = "pinion:streaming-draft";

/**
 * Build the assistant message for a still-streaming turn.
 *
 * `timestamp` defaults to now, but the draft is re-created on every streamed
 * delta, so the timestamp is NOT its identity: `id` is. Keying transcript rows
 * on the timestamp would remount the active step on every token (blinking
 * `.fade-up` animations, collapsed thinking/tool cards).
 */
export function streamingAssistantMessage(
  content: AssistantContent[],
  timestamp = Date.now(),
): AssistantMessage {
  return {
    role: "assistant",
    id: STREAMING_MESSAGE_ID,
    content,
    timestamp,
    stopReason: "streaming",
  };
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  total?: number;
  cost?: CostBreakdown | number;
}

export interface CostBreakdown {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export function assistantText(m: AgentMessage): string {
  if (!m || typeof m !== "object") return "";
  if (m.role === "user") {
    const c = (m as UserMessage).content;
    if (typeof c === "string") return c;
    if (Array.isArray(c))
      return c
        .map((b) =>
          typeof b === "string"
            ? b
            : b.type === "text"
              ? String((b as { text?: unknown }).text ?? "")
              : b.type === "image"
                ? "[image]"
                : "",
        )
        .join("");
    return "";
  }
  if (m.role === "assistant") {
    return ((m as AssistantMessage).content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b as TextContent).text)
      .join("");
  }
  if (m.role === "toolResult") {
    const c = (m as ToolResultMessage).content ?? [];
    return c.map((b) => String(b.text ?? "")).join("\n");
  }
  if (m.role === "bashExecution") {
    return (m as BashExecutionMessage).output ?? "";
  }
  return "";
}

export function messagePreview(m: AgentMessage, max = 120): string {
  const role = (m as { role?: string }).role ?? "?";
  if (role === "assistant") {
    const t = assistantText(m).trim();
    if (t) return t.slice(0, max);
    const calls = ((m as AssistantMessage).content ?? []).filter(
      (b) => b.type === "toolCall",
    ) as ToolCallContent[];
    if (calls.length) return `Used ${calls.map((c) => c.name).join(", ")}`;
    // Thinking-only messages are common while streaming; showing the reasoning
    // text beats a "…" placeholder (and beats the raw block JSON the sidebar
    // used to render).
    const thinking = ((m as AssistantMessage).content ?? [])
      .filter((b) => b.type === "thinking")
      .map((b) => (b as ThinkingContent).thinking)
      .join(" ")
      .trim();
    if (thinking) return thinking.slice(0, max);
    return "…";
  }
  const t = assistantText(m).trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : "…";
}

// ---------------------------------------------------------------------------
// Pi state / metadata
// ---------------------------------------------------------------------------

export interface PiModel {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, number>;
  [k: string]: unknown;
}

export interface SessionState {
  model?: PiModel | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  [k: string]: unknown;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: Usage & { total?: number };
  cost?: number | CostBreakdown;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number | null;
    percent?: number | null;
  } | null;
  [k: string]: unknown;
}

export interface ExtensionUiRequest extends Record<string, unknown> {
  type: "extension_ui_request";
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: string;
  text?: string;
  timeout?: number;
}

/**
 * A live pi subprocess, as surfaced by the running-processes panel.
 * `sessionId` is null for the shared server-side metadata process, which
 * belongs to no web session.
 */
export interface RunningProcessInfo {
  sessionId: string | null;
  kind: "session" | "server";
  /** Web session name (or a fixed label for the metadata process). */
  name: string;
  /** Working directory the process was spawned in (= the project folder). */
  cwd: string;
  pid: number | null;
  /** Agent working (agent_start..agent_settled) or compacting. */
  busy: boolean;
  startedAt: number;
  /** Last RPC activity — what the idle reaper measures. */
  lastActivity: number;
}

/** Process-management limits the server enforces (shown in the panel). */
export interface ProcessLimits {
  /** Soft cap on concurrent processes; 0 = unlimited. */
  maxProcesses: number;
  /** Idle reap timeout; 0 = never reaped. */
  idleTimeoutMs: number;
}

/**
 * Per-session sidebar state:
 *   - `working` — a pi process is attached and the agent is mid-turn
 *   - `idle`    — a pi process is attached but nothing is running
 * Sessions with no attached process are absent from the map (no indicator).
 */
export type SessionProcessState = "working" | "idle";

/** Collapse the live process inventory into per-session sidebar state. */
export function sessionProcessStates(
  processes: RunningProcessInfo[],
): Record<string, SessionProcessState> {
  const out: Record<string, SessionProcessState> = {};
  for (const p of processes) {
    if (!p.sessionId) continue; // shared server metadata process
    out[p.sessionId] = p.busy ? "working" : "idle";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Web session rows / control-plane inputs
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  name: string;
  cwd: string;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  piSessionId: string | null;
  piSessionFile: string | null;
  createdAt: number;
  updatedAt: number;
  /** Wall time (ms) of the last completed agent turn; null until one settles. */
  lastTurnMs: number | null;
}

export interface SessionListItem extends SessionRecord {
  preview: string | null;
  messageCount: number;
}

export interface CreateSessionInput {
  name?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

/** Wire values for POST /prompt `mode`. ChatView's UI value `"direct"` means omit `mode` (server defaults to `"prompt"`). Never send `mode: "direct"`. */
export type PromptMode = "prompt" | "steer" | "follow_up";

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PromptInput {
  message?: string;
  images?: PromptImage[];
  mode?: PromptMode;
  streamingBehavior?: "steer" | "followUp";
}

export interface SessionDetail {
  session: SessionRecord;
  state: SessionState | null;
  stats: SessionStats | null;
  messages: AgentMessage[];
  liveError: string | null;
  live: boolean;
}

export interface SessionMessagesSnapshot {
  messages: AgentMessage[];
  live: boolean;
  liveError?: string;
}

export interface SessionStatsSnapshot {
  state: SessionState | null;
  stats: SessionStats | null;
  live: boolean;
  stateError?: string | null;
  statsError?: string | null;
}

export interface ModelListing {
  models: PiModel[];
  state: unknown;
  thinkingLevels: string[] | null;
}

export interface DialogAnswer {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** Response payload of `GET /api/health`. */
export interface HealthSnapshot {
  app: "Pinion";
  piBinary: string;
  piVersion: string | null;
  piAvailable: boolean;
  defaultCwd: string;
  runtime: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
  pinned: boolean;
  missing: boolean;
  sessionCount: number;
  updatedAt: number;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

/** Everything the HTTP adapter needs to build a raw-file response. */
export interface RawFile {
  /** Absolute path on disk. The HTTP adapter streams it; never JSON this. */
  absPath: string;
  name: string;
  size: number;
  contentType: string;
  download: boolean;
}

// ---------------------------------------------------------------------------
// Call context (supervisor policy)
// ---------------------------------------------------------------------------

export type CallSource = "ui" | "supervisor" | "system";

export interface CallContext {
  source: CallSource;
  /** Session that issued the call, when source === "supervisor". */
  fromSessionId?: string;
  /** Stack of session ids already in this prompt chain. */
  chain: string[];
}

export const UI_CTX: CallContext = { source: "ui", chain: [] };

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Projected live events (SessionEvent = snapshot, never a delta)
// ---------------------------------------------------------------------------

export interface StreamingDraft {
  text: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; argsText: string }>;
  usage: Record<string, number> | null;
}

/** The subset of `ExtensionUiRequest` the UI renders as modals. */
export type DialogRequest = ExtensionUiRequest;

export interface SessionView {
  streaming: boolean;
  compacting: boolean;
  draft: StreamingDraft;
  toolLive: Record<string, { name: string; text: string }>;
  bashLive: Record<string, string>;
  queue: { steering: string[]; followUp: string[] };
  dialogs: DialogRequest[];
}

export type SessionEvent =
  | { type: "session.ready"; sessionId: string; ts: number }
  | { type: "turn.started" }
  | { type: "turn.ended" }
  | { type: "turn.settled"; durationMs?: number }
  | { type: "draft.cleared" }
  | { type: "draft.updated"; draft: StreamingDraft }
  | { type: "tool.started"; toolCallId: string; name: string }
  | { type: "tool.updated"; toolCallId: string; name: string; text: string }
  | { type: "tool.ended"; toolCallId: string }
  | { type: "bash.updated"; id: string; text: string }
  | { type: "queue.updated"; steering: string[]; followUp: string[] }
  | { type: "compaction.started" }
  | { type: "compaction.ended" }
  | { type: "retry.started"; attempt: string }
  | { type: "retry.ended"; success: boolean; error?: string }
  | { type: "dialog.requested"; dialog: DialogRequest }
  | { type: "notify"; kind: "info" | "warning" | "error"; message: string }
  | { type: "process.exited"; reason?: string; info?: unknown }
  | { type: "extension.error"; error: string };
