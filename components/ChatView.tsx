"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  Download,
  Eraser,
  FolderGit2,
  GitFork,
  Loader2,
  MoreHorizontal,
  Pencil,
  Shrink,
  Sparkles,
} from "lucide-react";
import { pinion, ClientError } from "@/lib/client";
import { exportDownloadUrl, exportFileName } from "@/lib/export-html";
import { usePiSession } from "@/hooks/usePiSession";
import { cn, formatDuration, truncate } from "@/lib/utils";
import { Composer, type OutgoingImage } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { MessageList } from "./MessageList";
import { MobileActionsMenu, type MobileAction } from "./MobileActionsMenu";
import { SessionStatChips } from "./TokenStats";
import { DialogModal, Toasts } from "./Overlays";
import type { PiModel, Usage } from "@/lib/control/types";

function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return {
    ref,
    onScroll: () => {
      const el = ref.current;
      if (!el) return;
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    },
    jumpToBottom: () => {
      const el = ref.current;
      if (el) {
        stick.current = true;
        el.scrollTop = el.scrollHeight;
      }
    },
  };
}

export function ChatView({
  sessionId,
  onRenamed,
  onSessionCloned,
}: {
  sessionId: string;
  onRenamed: () => void;
  onSessionCloned: (id: string) => void;
}) {
  const s = usePiSession(sessionId);
  const scroll = useAutoScroll([s.messages.length, s.streaming]);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showCmds, setShowCmds] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    scroll.jumpToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const send = async (text: string, images: OutgoingImage[], mode: "direct" | "steer" | "follow_up") => {
    const payload =
      mode === "direct"
        ? { message: text, images: images.length ? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })) : undefined }
        : { message: text, images: images.length ? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })) : undefined, mode };
    const errText = (err: unknown) =>
      err instanceof ClientError ? err.message : err instanceof Error ? err.message : String(err);
    try {
      await pinion.sessions.prompt(sessionId, payload);
    } catch (err) {
      // Agent busy without queue mode -> retry automatically as steer.
      if (mode === "direct") {
        try {
          await pinion.sessions.prompt(sessionId, { ...payload, streamingBehavior: "steer" });
        } catch (retryErr) {
          s.pushToast("error", errText(retryErr) || "Failed to send");
        }
      } else {
        s.pushToast("error", errText(err) || "Failed to send");
      }
    }
    // Belt-and-suspenders: show the accepted user message promptly even if
    // the SSE stream hiccups (stream events will reconcile right after).
    setTimeout(() => void s.refreshMessages(), 800);
    scroll.jumpToBottom();
  };

  const control = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(action);
    try {
      const r = await pinion.sessions.control(sessionId, { action, ...extra });
      if (action === "compact") s.pushToast("info", "Compaction requested.");
      if (action === "clear_queue") void s.refreshMessages();
      return r;
    } catch (err) {
      s.pushToast(
        "error",
        err instanceof ClientError ? err.message : `${action} failed`,
      );
      return null;
    } finally {
      setBusy(null);
    }
  };

  const pickModel = async (m: PiModel) => {
    try {
      await pinion.sessions.setModel(sessionId, { provider: m.provider, modelId: m.id });
      s.pushToast("info", `Model → ${String(m.provider ?? "")}/${m.id}`);
      void s.refreshStats();
    } catch (err) {
      s.pushToast(
        "error",
        err instanceof ClientError ? err.message : "Model switch failed",
      );
    }
  };

  const pickThinking = async (level: string) => {
    try {
      await pinion.sessions.setThinkingLevel(sessionId, level);
      void s.refreshStats();
    } catch (err) {
      s.pushToast(
        "error",
        err instanceof ClientError ? err.message : "Thinking switch failed",
      );
    }
  };

  const saveName = async () => {
    if (!nameDraft.trim()) {
      setEditingName(false);
      return;
    }
    try {
      await pinion.sessions.rename(sessionId, nameDraft.trim());
      s.setMeta((m) => (m ? { ...m, name: nameDraft.trim() } : m));
      onRenamed();
    } catch (err) {
      s.pushToast(
        "error",
        err instanceof ClientError ? err.message : "Rename failed",
      );
    }
    setEditingName(false);
  };

  const copyLast = () => {
    const last = [...s.baseMessages].reverse().find((m) => m.role === "assistant");
    const t = last
      ? ((last as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("")
      : "";
    if (t) void navigator.clipboard.writeText(t);
  };

  const exportHtml = async () => {
    const r = await control("export_html");
    if (!r) return;
    // The control plane stages the export in the OS temp dir; pull it down
    // from the same-origin download route (attachment, so the page stays put).
    triggerDownload(exportDownloadUrl(sessionId), exportFileName(sessionId));
    s.pushToast("info", "Export downloaded.");
  };

  const lifecycle = async (op: string, extra?: Record<string, unknown>) => {
    setBusy(op);
    try {
      const data = await pinion.sessions.lifecycle(sessionId, { op, ...extra });
      if (op === "clone" && data.clonedSession?.id) {
        onSessionCloned(data.clonedSession.id);
      } else {
        void s.reload();
        void s.refreshMessages();
      }
    } catch (err) {
      s.pushToast(
        "error",
        err instanceof ClientError ? err.message : `${op} failed`,
      );
    } finally {
      setBusy(null);
    }
  };

  const stats = s.stats;
  const tokens = stats?.tokens as Usage | undefined;
  const cost = typeof stats?.cost === "number" ? stats.cost : (stats?.cost as { total?: number } | undefined)?.total;
  const costValue = typeof cost === "number" ? cost : null;
  const ctx = stats?.contextUsage as { percent?: number | null; tokens?: number | null; contextWindow?: number | null } | null | undefined;
  // While asleep there is no live state — fall back to the model persisted on
  // the session row so the picker still shows what it will resume with.
  const currentModel =
    (s.state?.model as PiModel | null | undefined) ??
    (s.meta?.modelId
      ? ({ id: s.meta.modelId, provider: s.meta.provider ?? undefined } as PiModel)
      : null);

  const onMenuAction = (action: MobileAction) => {
    setShowMenu(false);
    switch (action) {
      case "commands":
        setShowCmds((v) => !v);
        break;
      case "compact":
        void control("compact");
        break;
      case "copy":
        copyLast();
        break;
      case "export":
        void exportHtml();
        break;
      case "clear":
        void control("clear_queue");
        break;
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header */}
      {/* `relative z-20` matters: the header's backdrop-blur makes it a stacking
          context, so without a positive z-index the z-50 model/overflow menus
          are trapped beneath .fade-up message rows (fill-mode `both` keeps
          translateY(0), which leaves each row a z-index:0 stacking context).
          Stay below the mobile drawer scrim (z-30). */}
      <header className="relative z-20 flex shrink-0 flex-wrap items-center gap-2 border-b border-line/80 bg-app/90 px-3 py-2.5 backdrop-blur sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={void saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") setEditingName(false);
              }}
              className="w-52 rounded-lg border border-line-strong bg-panel px-2 py-1 text-[13px] focus:border-line-focus focus:outline-none"
            />
          ) : (
            <button
              onClick={() => {
                setNameDraft(s.meta?.name ?? "");
                setEditingName(true);
              }}
              className="group flex min-w-0 items-center gap-1.5"
              title="Rename session"
            >
              <h1 className="truncate text-[14px] font-semibold text-fg">
                {s.meta?.name ?? "…"}
              </h1>
              <Pencil size={12} className="shrink-0 text-fg-faint opacity-0 transition group-hover:opacity-100" />
            </button>
          )}
        </div>

        <ModelPicker
          models={s.models}
          current={currentModel}
          thinkingLevels={s.thinkingLevels}
          currentThinking={s.state?.thinkingLevel ?? s.meta?.thinkingLevel}
          onOpen={() => void s.loadModels()}
          onPick={(m) => void pickModel(m)}
          onThinking={(lv) => void pickThinking(lv)}
        />

        <div className="ml-auto flex items-center gap-1.5">
          {/* Stat chips: inline from lg up — hidden until a live process reports usage */}
          {s.stats && (
            <div className="mr-1 hidden lg:flex">
              <SessionStatChips tokens={tokens} cost={costValue} ctx={ctx} />
            </div>
          )}

          {/* Mobile overflow menu */}
          <div className="relative md:hidden">
            <HeaderBtn title="More actions" onClick={() => setShowMenu((v) => !v)} active={showMenu}>
              <MoreHorizontal size={15} />
            </HeaderBtn>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <MobileActionsMenu
                  onSelect={onMenuAction}
                  className="absolute right-0 top-full z-50 mt-1.5 w-52"
                />
              </>
            )}
          </div>

          {/* Full action row: tablet and up. The commands panel contains the
              slash-command list *and* the fork/clone buttons, so it has one
              entry point — two icons for one panel read as toolbar soup. */}
          <div className="hidden items-center gap-1.5 md:flex">
          <HeaderBtn
            title="Compact context"
            onClick={() => void control("compact")}
            loading={busy === "compact" || s.compacting}
          >
            <Shrink size={14} />
          </HeaderBtn>
          <HeaderBtn title="Copy last assistant message" onClick={copyLast}>
            <Copy size={14} />
          </HeaderBtn>
          <HeaderBtn
            title="Export session to HTML"
            onClick={() => void exportHtml()}
            loading={busy === "export_html"}
          >
            <Download size={14} />
          </HeaderBtn>
          <HeaderBtn title="Clear queued messages" onClick={() => void control("clear_queue")}>
            <Eraser size={14} />
          </HeaderBtn>
          <HeaderBtn title="Commands & session options (fork, clone)" onClick={() => setShowCmds((v) => !v)} active={showCmds}>
            <GitFork size={14} />
          </HeaderBtn>
          </div>
        </div>

        {/* Stat strip below lg: token/cost/context would otherwise vanish on phones. */}
        {s.stats && (
          <div className="flex basis-full justify-start lg:hidden">
            <SessionStatChips tokens={tokens} cost={costValue} ctx={ctx} align="left" />
          </div>
        )}

        {showCmds && (
          <div className="basis-full">
            <div className="mb-2 rounded-xl border border-line bg-panel/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
                  Slash commands ({s.commands.length})
                </span>
                <div className="flex gap-1.5">
                  <MiniBtn onClick={() => void lifecycle("clone")} loading={busy === "clone"}>
                    Clone branch
                  </MiniBtn>
                </div>
              </div>
              {s.commands.length === 0 ? (
                <p className="text-[12px] text-fg-subtle">No extension commands, prompts or skills found.</p>
              ) : (
                <div className="grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">
                  {s.commands.map((c) => (
                    <button
                      key={`${c.source}:${c.name}`}
                      onClick={() => {
                        void send(`/${c.name} `, [], "direct");
                        setShowCmds(false);
                      }}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-raised"
                      title={c.description ?? c.name}
                    >
                      <code className="shrink-0 font-mono text-[11.5px] text-accent">/{truncate(c.name, 28)}</code>
                      <span className="truncate text-[11.5px] text-fg-subtle">{c.description ?? c.source}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {s.meta && (
          <div className="flex basis-full items-center gap-1.5 text-[11px] text-fg-subtle">
            <span
              title={s.connected ? "Live updates connected" : "Connecting live updates…"}
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                s.connected ? "bg-success" : "streaming-dot bg-warning",
              )}
            />
            <FolderGit2 size={11} />
            <span className="truncate font-mono">{s.meta.cwd}</span>
            {s.liveError && <span className="ml-2 text-warning/90">· {s.liveError}</span>}
          </div>
        )}
      </header>

      {/* Messages */}
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-3 py-6 sm:px-4">
          {s.loading && s.messages.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-fg-subtle">
              <Loader2 size={15} className="animate-spin" /> Loading session…
            </div>
          ) : s.messages.length === 0 && !s.streaming ? (
            <EmptyState
              cwd={s.meta?.cwd}
              modelLabel={
                s.state?.model
                  ? `${(s.state.model as PiModel).provider ?? ""}/${(s.state.model as PiModel).id}`
                  : undefined
              }
              onExample={(t) => void send(t, [], "direct")}
            />
          ) : (
            <MessageList
              messages={s.messages}
              toolResults={s.toolResults}
              toolLive={s.toolLive}
              streaming={s.streaming}
            />
          )}
          {(s.streaming || s.compacting) && (
            <div className="flex items-center gap-2 text-[12px] text-fg-subtle">
              <Loader2 size={13} className="animate-spin" />
              {s.compacting ? "Compacting context…" : "Agent is working…"}
              {(s.queue.steering.length > 0 || s.queue.followUp.length > 0) && (
                <span className="text-fg-faint">
                  ({s.queue.steering.length + s.queue.followUp.length} queued)
                </span>
              )}
            </div>
          )}
          {!s.streaming && !s.compacting && s.lastTurnMs != null && (
            <p className="text-[11px] text-fg-faint">
              Completed in {formatDuration(s.lastTurnMs)}
            </p>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-4 sm:pb-4">
        <div className="mx-auto max-w-3xl">
          <Composer
            streaming={s.streaming}
            compacting={s.compacting}
            queueCounts={{ steering: s.queue.steering.length, followUp: s.queue.followUp.length }}
            commands={s.commands}
            sessionId={sessionId}
            onIntent={() => void s.ensureProcess()}
            onSend={(t, imgs, mode) => void send(t, imgs, mode)}
            onAbort={() => void control("abort")}
          />
          <p className="mt-1.5 text-center text-[10.5px] text-fg-faint">
            {!s.loading && !s.hasProcess ? (
              <>
                pi process asleep · focus the message box to start it
                <span className="text-fg-faint"> · </span>
                <span className="font-mono">{truncate(s.meta?.cwd ?? "", 48)}</span>
              </>
            ) : (
              <>
                Pi runs tools in <span className="font-mono">{truncate(s.meta?.cwd ?? "", 48)}</span> · Enter to
                send · Shift+Enter for newline
              </>
            )}
          </p>
        </div>
      </div>

      {s.dialogs[0] && <DialogModal dialog={s.dialogs[0]} onAnswer={(id, p) => void s.answerDialog(id, p)} />}
      <Toasts toasts={s.toasts} onDismiss={s.dismissToast} />
    </div>
  );
}

/**
 * Hand a same-origin URL to the browser's download manager. The endpoint
 * answers with `Content-Disposition: attachment`, so the page is not left.
 */
function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function HeaderBtn({
  children,
  title,
  onClick,
  active,
  loading,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-lg p-2 transition",
        active ? "bg-raised text-fg" : "text-fg-subtle hover:bg-raised/70 hover:text-fg-secondary",
      )}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : children}
    </button>
  );
}

function MiniBtn({
  children,
  onClick,
  loading,
}: {
  children: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-raised/60 px-2.5 py-1 text-[11.5px] text-fg-secondary transition hover:bg-active disabled:opacity-50"
    >
      {loading && <Loader2 size={11} className="animate-spin" />}
      {children}
    </button>
  );
}

function EmptyState({
  cwd,
  modelLabel,
  onExample,
}: {
  cwd?: string;
  modelLabel?: string;
  onExample: (t: string) => void;
}) {
  const examples = [
    "Explain this project structure and where to start",
    "Run the tests and fix any failures",
    "Review my uncommitted changes",
  ];
  return (
    <div className="py-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel">
        <Sparkles size={20} className="text-fg-secondary" />
      </div>
      <h2 className="text-[16px] font-semibold text-fg">What should we build?</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-fg-subtle">
        Pi has file tools in <span className="font-mono text-fg-muted">{truncate(cwd ?? "", 56)}</span>
        {modelLabel && (
          <>
            {" "}· running <span className="font-mono text-fg-muted">{modelLabel}</span>
          </>
        )}
        . Ask anything to get started.
      </p>
      <div className="mx-auto mt-5 grid max-w-lg gap-2">
        {examples.map((e) => (
          <button
            key={e}
            onClick={() => onExample(e)}
            className="rounded-xl border border-line bg-panel/50 px-4 py-2.5 text-left text-[12.5px] text-fg-secondary transition hover:border-line-strong hover:bg-panel"
          >
            {e}
          </button>
        ))}
      </div>
      <p className="mt-4 flex items-center justify-center gap-1 text-[11px] text-fg-faint">
        Tip: type <code className="rounded bg-raised px-1 font-mono">/&lt;tab&gt;</code> via the
        <ChevronDown size={10} className="inline" /> button above for skills & prompts
      </p>
    </div>
  );
}
