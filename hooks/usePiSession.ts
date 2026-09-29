"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pinion, ClientError } from "@/lib/client";
import { applySessionEvent, emptySessionView } from "@/lib/control/projector";
import {
  streamingAssistantMessage,
  type AgentMessage,
  type AssistantContent,
  type PiModel,
  type SessionEvent,
  type SessionState,
  type SessionStats,
  type SessionView,
} from "@/lib/control/types";

interface SessionMeta {
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
  lastTurnMs: number | null;
}

export interface Toast {
  id: string;
  kind: "info" | "warning" | "error";
  message: string;
}

/** How long a toast stays before auto-dismissing. */
const TOAST_DISMISS_MS = 6000;

/**
 * Coerce a duration from JSON to a displayable number. The server contract is
 * `number | null`, but a drifted schema (or an old build) can hand back the
 * raw column name — that must hide the footer, not render "Completed in —".
 */
function asTurnMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function usePiSession(sessionId: string | null) {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [view, setView] = useState<SessionView>(() => emptySessionView());
  /** True when a pi subprocess is attached (state/stats come from it). */
  const [hasProcess, setHasProcess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [models, setModels] = useState<PiModel[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [commands, setCommands] = useState<
    Array<{ name: string; description?: string; source: string }>
  >([]);
  const [connected, setConnected] = useState(false);
  /**
   * Wall time of the last completed agent turn (ms), measured by the manager
   * and persisted on the session row, so refreshes keep it. Null until a turn
   * settles.
   */
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Auto-dismiss timers keyed by toast id, cancelled on dismiss / unmount. */
  const toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const pushToast = useCallback((kind: Toast["kind"], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((t) => [...t.slice(-4), { id, kind, message }]);
    const timer = setTimeout(() => {
      toastTimers.current.delete(id);
      setToasts((t) => t.filter((x) => x.id !== id));
    }, TOAST_DISMISS_MS);
    toastTimers.current.set(id, timer);
  }, []);

  const refreshMessages = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await pinion.sessions.messages(sessionId);
      setMessages(data.messages);
      setHasProcess(Boolean(data.live));
      // `live: false` alone means the session is asleep — that is normal, not
      // an error. Only surface a message when the server reports a failure.
      if (data.liveError) setLiveError(data.liveError);
      else if (data.live) setLiveError(null);
    } catch {
      /* ignore transient */
    }
  }, [sessionId]);

  const refreshStats = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await pinion.sessions.stats(sessionId);
      if (typeof data.live === "boolean") setHasProcess(data.live);
      if (data.state) setState(data.state);
      if (data.stats) setStats(data.stats);
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refreshMessages();
      void refreshStats();
    }, 450);
  }, [refreshMessages, refreshStats]);

  const loadSession = useCallback(async () => {
    if (!sessionId) {
      setMeta(null);
      setMessages([]);
      setState(null);
      setStats(null);
      return;
    }
    setLoading(true);
    try {
      const data = await pinion.sessions.get(sessionId);
      setMeta(data.session);
      setState(data.state);
      setStats(data.stats);
      setMessages(data.messages ?? []);
      setLiveError(data.liveError);
      setHasProcess(Boolean(data.live));
      setLastTurnMs(asTurnMs(data.session.lastTurnMs));
      setView((v) => ({
        ...v,
        streaming: Boolean(data.state?.isStreaming),
        compacting: Boolean(data.state?.isCompacting),
      }));
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const loadModels = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await pinion.sessions.getModel(sessionId);
      setModels((data.models ?? []) as PiModel[]);
      if (data.thinkingLevels) setThinkingLevels(data.thinkingLevels);
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  const loadCommands = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await pinion.sessions.control(sessionId, { action: "get_commands" });
      const cmds = (
        data.response?.data as
          | { commands?: Array<{ name: string; description?: string; source: string }> }
          | undefined
      )?.commands;
      if (Array.isArray(cmds)) setCommands(cmds);
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  // Initial load. Read-only: no pi process is started (the composer calls
  // `ensureProcess` on focus), so models/commands are fetched after spawn.
  useEffect(() => {
    setView((v) => ({ ...emptySessionView(), queue: v.queue }));
    setHasProcess(false);
    setLastTurnMs(null);
    void loadSession();
  }, [sessionId, loadSession]);

  // Live stream. `pinion.sessions.subscribe` owns the EventSource and one
  // projector per subscription; this hook folds the snapshot events into view
  // state and runs the REST/toast side effects the projector deliberately
  // does not know about.
  useEffect(() => {
    if (!sessionId) return;
    let current = emptySessionView();

    const onEvent = (ev: SessionEvent) => {
      current = applySessionEvent(current, ev);
      setView(current);

      switch (ev.type) {
        case "session.ready":
          setConnected(true);
          setLiveError(null);
          break;
        case "turn.started":
          setLastTurnMs(null);
          break;
        case "turn.settled":
          // The manager measures the turn and annotates the settle event, so
          // this matches what a later refresh reads from the session row.
          setLastTurnMs(asTurnMs(ev.durationMs));
          void refreshMessages();
          void refreshStats();
          break;
        case "turn.ended":
          scheduleRefresh();
          break;
        case "tool.ended":
          // Mid-turn toolResult rows.
          scheduleRefresh();
          break;
        case "compaction.started":
          pushToast("info", "Compacting context…");
          break;
        case "compaction.ended":
          void refreshMessages();
          void refreshStats();
          break;
        case "retry.started":
          pushToast("warning", `Retrying after transient error (attempt ${ev.attempt})…`);
          break;
        case "retry.ended":
          if (ev.success !== true) {
            pushToast("error", `Retry failed: ${ev.error ?? "unknown error"}`);
          }
          break;
        case "notify":
          pushToast(ev.kind, ev.message);
          break;
        case "extension.error":
          pushToast("error", `Extension error: ${ev.error}`);
          break;
        case "process.exited":
          // The turn never completed — do not let the old row value reappear.
          setLastTurnMs(null);
          // Keep the (wrong) legacy copy: focusing the composer respawns.
          pushToast("error", "Pi process exited. Reload the session to respawn it.");
          break;
        default:
          break;
      }
    };

    let off: () => void;
    try {
      off = pinion.sessions.subscribe(sessionId, onEvent, {
        onClose: () => setConnected(false),
      });
    } catch {
      // No EventSource (SSR / tests without a DOM): REST still works.
      return;
    }

    return () => {
      off();
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      setConnected(false);
    };
  }, [sessionId, pushToast, refreshMessages, refreshStats, scheduleRefresh]);

  // Poll stats while streaming.
  useEffect(() => {
    if (!sessionId || !view.streaming) return;
    const t = setInterval(() => void refreshStats(), 8000);
    return () => clearInterval(t);
  }, [sessionId, view.streaming, refreshStats]);

  const toolResults = useMemo(() => {
    const map = new Map<string, AgentMessage>();
    for (const m of messages) {
      if ((m as { role?: string }).role === "toolResult") {
        const id = String((m as { toolCallId?: unknown }).toolCallId ?? "");
        if (id) map.set(id, m);
      }
    }
    return map;
  }, [messages]);

  const streamingAssistant = useMemo((): AgentMessage | null => {
    const draft = view.draft;
    if (!view.streaming) return null;
    if (!draft.text && !draft.thinking && draft.toolCalls.length === 0) return null;
    const content: AssistantContent[] = [];
    if (draft.thinking) content.push({ type: "thinking", thinking: draft.thinking });
    if (draft.text) content.push({ type: "text", text: draft.text });
    for (const tc of draft.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.argsText ? (JSON.parse(tc.argsText) as Record<string, unknown>) : {};
      } catch {
        args = { _partial: tc.argsText };
      }
      content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: args });
    }
    return streamingAssistantMessage(content);
  }, [view.streaming, view.draft]);

  const visibleMessages = useMemo(
    () => (streamingAssistant ? [...messages, streamingAssistant] : messages),
    [messages, streamingAssistant],
  );

  const ensuring = useRef<Promise<boolean> | null>(null);

  /**
   * Spawn (or reuse) the pi process on explicit user intent — the composer
   * calls this when it gains focus. Deduped client-side; the server dedupes
   * concurrent spawns too. Returns true once a process is attached.
   */
  const ensureProcess = useCallback((): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false);
    if (!ensuring.current) {
      ensuring.current = (async () => {
        try {
          const data = await pinion.sessions.start(sessionId);
          setHasProcess(data.live !== false);
          // Everything that needs a live process is (re)loaded now.
          void refreshStats();
          void refreshMessages();
          void loadCommands();
          void loadModels();
          return true;
        } catch (e) {
          pushToast("error", e instanceof ClientError ? e.message : String(e));
          return false;
        } finally {
          ensuring.current = null;
        }
      })();
    }
    return ensuring.current;
  }, [sessionId, refreshStats, refreshMessages, loadCommands, loadModels, pushToast]);

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  // A leaked auto-dismiss timer fires after unmount and calls setState with no
  // DOM (SSR/test teardown), which is a `window is not defined` crash waiting
  // for whatever code runs next. Cancel them all with the component.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const answerDialog = useCallback(
    async (
      dialogId: string,
      payload: { value?: string; confirmed?: boolean; cancelled?: boolean },
    ) => {
      if (!sessionId) return;
      setView((v) => ({ ...v, dialogs: v.dialogs.filter((x) => x.id !== dialogId) }));
      try {
        await pinion.sessions.answerDialog(sessionId, { id: dialogId, ...payload });
      } catch {
        /* ignore */
      }
    },
    [sessionId],
  );

  return {
    meta,
    setMeta,
    state,
    stats,
    messages: visibleMessages,
    baseMessages: messages,
    toolResults,
    toolLive: view.toolLive,
    bashLive: view.bashLive,
    streaming: view.streaming,
    compacting: view.compacting,
    lastTurnMs,
    loading,
    hasProcess,
    ensureProcess,
    loadModels,
    liveError,
    connected,
    queue: view.queue,
    dialogs: view.dialogs,
    toasts,
    models,
    thinkingLevels,
    commands,
    pushToast,
    dismissToast,
    answerDialog,
    refreshMessages,
    refreshStats,
    reload: loadSession,
  };
}
