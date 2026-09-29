"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerLeftUp, FileText, Folder, ImagePlus, Loader2, Send, Square, X } from "lucide-react";
import { pinion } from "@/lib/client";
import { cn } from "@/lib/utils";
import {
  applyDirMention,
  applyFileMention,
  filterMentionEntries,
  mentionToken,
  normalizeMentionDir,
  parentMentionDir,
  splitMentionPath,
  type MentionEntry,
} from "@/lib/file-mentions";
import {
  filterSlashCommands,
  insertSlashCommand,
  slashQuery,
  type SlashCommand,
} from "@/lib/slash-commands";

export interface OutgoingImage {
  data: string;
  mimeType: string;
}

interface Props {
  streaming: boolean;
  compacting: boolean;
  queueCounts: { steering: number; followUp: number };
  /** Extension commands, prompts and skills offered when the input starts with `/`. */
  commands?: SlashCommand[];
  /** Current session — needed to list the working directory for `@` mentions. */
  sessionId?: string;
  /** Fired when the input gains focus — the cue to start a sleeping pi process. */
  onIntent?: () => void;
  onSend: (text: string, images: OutgoingImage[], queueMode: "direct" | "steer" | "follow_up") => void;
  onAbort: () => void;
  disabled?: boolean;
}

const MAX_MENU_ITEMS = 50;
const PARENT_PATH = "..";
const PARENT_ENTRY: MentionEntry = { name: PARENT_PATH, type: "dir", path: PARENT_PATH };

interface FileListing {
  dir: string;
  entries: MentionEntry[];
  loading: boolean;
  error: string | null;
}

export function Composer({
  streaming,
  compacting,
  queueCounts,
  commands = [],
  sessionId,
  onIntent,
  onSend,
  onAbort,
  disabled,
}: Props) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [images, setImages] = useState<OutgoingImage[]>([]);
  const [queueMode, setQueueMode] = useState<"direct" | "steer" | "follow_up">("direct");
  const [activeIdx, setActiveIdx] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [files, setFiles] = useState<FileListing>({ dir: "", entries: [], loading: false, error: null });
  const filesCache = useRef(new Map<string, MentionEntry[]>());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // `/command-name` while it is still being typed; null once a space turns
  // the rest into the command's custom message (or when not in command position).
  const query = commands.length > 0 ? slashQuery(text) : null;
  const matches = useMemo(
    () => (query == null ? [] : filterSlashCommands(commands, query).slice(0, MAX_MENU_ITEMS)),
    [commands, query],
  );
  const menuOpen = query != null && !menuDismissed;

  // `@path` before the cursor browses the session working directory.
  const mention = sessionId ? mentionToken(text, cursor) : null;
  const mentionPath = mention ? splitMentionPath(mention.query) : null;
  const mentionDir = mentionPath?.dir ?? "";
  const mentionFilter = mentionPath?.filter ?? "";
  const mentionOpen = mention != null && !mentionDismissed;
  const normalizedDir = normalizeMentionDir(mentionDir);
  const filesLoading = files.loading || files.dir !== mentionDir;

  const mentionRows = useMemo<MentionEntry[]>(() => {
    if (!mentionOpen) return [];
    const base = files.dir === mentionDir ? files.entries : [];
    const filtered = filterMentionEntries(base, mentionFilter).slice(0, MAX_MENU_ITEMS);
    return normalizedDir && !mentionFilter ? [PARENT_ENTRY, ...filtered] : filtered;
  }, [mentionOpen, files, mentionDir, mentionFilter, normalizedDir]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, mentionDir, mentionFilter, mentionOpen]);

  useEffect(() => {
    if (!menuOpen && !mentionOpen) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIdx, menuOpen, mentionOpen]);

  // One request per folder (cached); typing a filter never refetches.
  useEffect(() => {
    if (!mentionOpen || !sessionId) return;
    const cached = filesCache.current.get(mentionDir);
    if (cached) {
      setFiles({ dir: mentionDir, entries: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setFiles({ dir: mentionDir, entries: [], loading: true, error: null });
    void (async () => {
      try {
        const data = await pinion.files.mentions(sessionId, mentionDir);
        if (cancelled) return;
        filesCache.current.set(mentionDir, data.entries);
        setFiles({ dir: mentionDir, entries: data.entries, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setFiles({
          dir: mentionDir,
          entries: [],
          loading: false,
          error: err instanceof Error ? err.message : "Could not list this folder",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, mentionDir, sessionId]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [text]);

  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled && !compacting;

  const accept = (command: SlashCommand) => {
    setText(insertSlashCommand(command.name));
    setMenuDismissed(false);
    taRef.current?.focus();
  };

  /** Folders navigate one level deeper; files complete the mention and close it. */
  const activateMention = (entry: MentionEntry) => {
    if (!mention) return;
    const isParent = entry.path === PARENT_PATH;
    const next =
      entry.type === "file"
        ? applyFileMention(text, mention, cursor, entry.path)
        : applyDirMention(text, mention, cursor, isParent ? parentMentionDir(mentionDir) : entry.path);
    setText(next.text);
    setCursor(next.cursor);
    setMentionDismissed(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try {
        ta.setSelectionRange(next.cursor, next.cursor);
      } catch {
        /* ignore */
      }
    });
  };

  const submit = () => {
    if (!canSend) return;
    const mode = streaming ? (queueMode === "direct" ? "steer" : queueMode) : "direct";
    onSend(text.trim(), images, mode);
    setText("");
    setCursor(0);
    setImages([]);
    setQueueMode("direct");
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const pickImages = async (list: FileList | null) => {
    if (!list) return;
    const next: OutgoingImage[] = [...images];
    for (const f of Array.from(list).slice(0, 4 - images.length)) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > 6 * 1024 * 1024) continue;
      const buf = await f.arrayBuffer();
      const b64 = btoa(
        new Uint8Array(buf).reduce((acc, b) => acc + String.fromCharCode(b), ""),
      );
      next.push({ data: b64, mimeType: f.type });
    }
    setImages(next);
  };

  return (
    <div className="relative z-20 rounded-2xl border border-line-strong/60 bg-panel/80 shadow-[0_8px_40px_-12px_var(--pinion-shadow-color)] backdrop-blur transition focus-within:border-line-focus">
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute inset-x-0 bottom-full z-50 mb-2 max-h-[280px] overflow-y-auto rounded-2xl border border-line-strong/70 bg-panel p-1.5 shadow-2xl"
        >
          <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-subtle">
              Slash commands
            </span>
            <span className="font-mono text-[10px] text-fg-faint">↑↓ navigate · Enter pick</span>
          </div>
          {matches.length === 0 ? (
            <div className="px-2.5 py-3 text-[12px] text-fg-subtle">No commands match “{query}”.</div>
          ) : (
            <div role="listbox" aria-label="Slash commands">
              {matches.map((c, i) => (
                <button
                  key={`${c.source}:${c.name}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeIdx}
                  data-cmd-index={i}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => accept(c)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition",
                    i === activeIdx ? "bg-raised" : "hover:bg-raised/60",
                  )}
                >
                  <code className="shrink-0 font-mono text-[12px] text-accent">/{c.name}</code>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-subtle">
                    {c.description ?? ""}
                  </span>
                  <span className="shrink-0 rounded-full bg-raised px-1.5 py-px font-mono text-[10px] text-fg-subtle">
                    {c.source}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {mentionOpen && (
        <div
          ref={menuRef}
          className="absolute inset-x-0 bottom-full z-50 mb-2 max-h-[280px] overflow-y-auto rounded-2xl border border-line-strong/70 bg-panel p-1.5 shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-1.5">
            <span className="truncate text-[10.5px] font-semibold uppercase tracking-wider text-fg-subtle">
              Files · {normalizedDir ? `${normalizedDir}/` : "project root"}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-fg-faint">
              {filesLoading ? "loading…" : "↑↓ navigate · Enter open"}
            </span>
          </div>
          {filesLoading ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-[12px] text-fg-subtle">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : files.error ? (
            <div className="px-2.5 py-3 text-[12px] text-warning-soft/90">{files.error}</div>
          ) : mentionRows.length === 0 ? (
            <div className="px-2.5 py-3 text-[12px] text-fg-subtle">
              {mentionFilter ? `Nothing matches “${mentionFilter}”.` : "Empty folder."}
            </div>
          ) : (
            <div role="listbox" aria-label="Files and folders">
              {mentionRows.map((entry, i) => {
                const isParent = entry.path === PARENT_PATH;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    role="option"
                    aria-selected={i === activeIdx}
                    data-mention-path={entry.path}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => activateMention(entry)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition",
                      i === activeIdx ? "bg-raised" : "hover:bg-raised/60",
                    )}
                  >
                    {isParent ? (
                      <CornerLeftUp size={13} className="shrink-0 text-fg-subtle" />
                    ) : entry.type === "dir" ? (
                      <Folder size={13} className="shrink-0 text-warning-soft/80" />
                    ) : (
                      <FileText size={13} className="shrink-0 text-fg-subtle" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                      {isParent ? ".." : entry.name}
                      {entry.type === "dir" && !isParent ? "/" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {images.map((img, i) => (
            <div key={i} className="relative overflow-hidden rounded-lg border border-line-strong">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`attachment ${i + 1}`}
                className="h-14 w-14 object-cover"
              />
              <button
                onClick={() => setImages((arr) => arr.filter((_, j) => j !== i))}
                className="absolute right-0.5 top-0.5 rounded-full bg-overlay/70 p-0.5 text-fg-secondary hover:text-primary-fg"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        onFocus={() => onIntent?.()}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
          setMenuDismissed(false);
          setMentionDismissed(false);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (mentionOpen && mentionRows.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIdx((i) => (i + 1) % mentionRows.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIdx((i) => (i - 1 + mentionRows.length) % mentionRows.length);
              return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              activateMention(mentionRows[Math.min(activeIdx, mentionRows.length - 1)]);
              return;
            }
          }
          if (mentionOpen && e.key === "Escape") {
            // Cancel the picker, but keep the `@` the user typed.
            e.preventDefault();
            setMentionDismissed(true);
            return;
          }
          if (menuOpen && matches.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIdx((i) => (i + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              accept(matches[Math.min(activeIdx, matches.length - 1)]);
              return;
            }
          }
          if (menuOpen && e.key === "Escape") {
            e.preventDefault();
            setMenuDismissed(true);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={
          streaming
            ? "Agent is working… type to steer or queue a follow-up (Enter)"
            : "Ask anything…  (Shift+Enter for newline, / commands, @ files)"
        }
        className="max-h-[200px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed text-fg placeholder:text-fg-faint focus:outline-none"
      />
      <div className="flex items-center gap-2 px-3 pb-3 pt-1">
        <button
          onClick={() => fileRef.current?.click()}
          className="rounded-lg p-2 text-fg-subtle transition hover:bg-raised hover:text-fg-secondary"
          title="Attach images"
        >
          <ImagePlus size={17} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void pickImages(e.target.files);
            e.target.value = "";
          }}
        />
        {streaming && (
          <div className="flex items-center gap-1 rounded-lg bg-raised/80 p-0.5 text-[11.5px]">
            {(
              [
                ["direct", "Steer"],
                ["follow_up", "Follow-up"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setQueueMode(v)}
                className={cn(
                  "rounded-md px-2 py-1 font-medium transition",
                  queueMode === v
                    ? "bg-active text-fg"
                    : "text-fg-subtle hover:text-fg-secondary",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {(queueCounts.steering > 0 || queueCounts.followUp > 0) && (
          <span className="text-[11px] text-fg-subtle">
            {queueCounts.steering > 0 && `${queueCounts.steering} steering`}
            {queueCounts.steering > 0 && queueCounts.followUp > 0 && " · "}
            {queueCounts.followUp > 0 && `${queueCounts.followUp} queued`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {streaming && (
            <button
              onClick={onAbort}
              className="flex items-center gap-1.5 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2 text-[13px] font-medium text-danger-soft transition hover:bg-danger/20"
            >
              <Square size={13} className="fill-current" />
              Stop
            </button>
          )}
          <button
            onClick={submit}
            disabled={!canSend}
            className={cn(
              "flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-medium transition",
              canSend
                ? "bg-primary text-primary-fg hover:bg-primary-hover"
                : "cursor-not-allowed bg-raised text-fg-faint",
            )}
          >
            {compacting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
