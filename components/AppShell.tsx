"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Menu, PanelLeft, TriangleAlert, Activity, FolderTree, GitBranch } from "lucide-react";
import { pinion } from "@/lib/client";
import type { ProcessLimits, RunningProcessInfo, SessionListItem } from "@/lib/control/types";
import { MOBILE_QUERY, nextRightPanel, nextSidebarUser, type RightPanelKind } from "@/lib/layout";
import { sessionProcessStates, type SessionProcessState } from "@/lib/control/types";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useProjects } from "@/hooks/useProjects";
import { cn } from "@/lib/utils";
import { ChatView } from "./ChatView";
import { FileBrowser, type FilePanelMode } from "./FileBrowser";
import { GitPanel } from "./GitPanel";
import { NewSessionModal } from "./NewSessionModal";
import { ProcessPanel, SERVER_PROCESS_KEY } from "./ProcessPanel";
import { Sidebar } from "./Sidebar";
import { ThemeProvider } from "./ThemeProvider";
import { ThemeMenu } from "./ThemeMenu";

export function AppShell() {
  return (
    <ThemeProvider>
      <AppShellContent />
    </ThemeProvider>
  );
}

function AppShellContent() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newModal, setNewModal] = useState<{ cwd: string } | null>(null);
  const { projects, refresh: refreshProjects, pin, unpin } = useProjects();
  const [defaultCwd, setDefaultCwd] = useState("");
  const [piInfo, setPiInfo] = useState<{ piVersion: string | null; piAvailable: boolean } | null>(null);
  // Tri-state: null = follow the CSS default (drawer hidden on mobile,
  // panel shown on desktop). Identical on server and first client render,
  // so no hydration mismatch; explicit only after user interaction.
  const [sidebarOpen, setSidebarOpen] = useState<boolean | null>(null);
  const isMobile = useMediaQuery(MOBILE_QUERY);

  // Right-side rails: Files and Git share one slot, always start collapsed
  // (never restored from storage) and only one can be open at a time.
  const [rightPanel, setRightPanel] = useState<RightPanelKind>("closed");
  const [panelMode, setPanelMode] = useState<FilePanelMode>("docked");

  const toggleRightPanel = useCallback((which: "files" | "git") => {
    setRightPanel((current) => nextRightPanel(current, which));
  }, []);

  const closeRightPanel = useCallback(() => {
    setRightPanel("closed");
    setPanelMode("docked");
  }, []);

  // Running pi processes: polled for the strip badge and the process panel.
  const [processes, setProcesses] = useState<RunningProcessInfo[]>([]);
  const [processLimits, setProcessLimits] = useState<ProcessLimits>({
    maxProcesses: 0,
    idleTimeoutMs: 0,
  });
  const [procPanelOpen, setProcPanelOpen] = useState(false);
  const [procLoading, setProcLoading] = useState(false);
  const [procBusyKey, setProcBusyKey] = useState<string | null>(null);

  const loadProcesses = useCallback(async (showSpinner = false) => {
    if (showSpinner) setProcLoading(true);
    try {
      const data = await pinion.processes.list();
      setProcesses(data.processes ?? []);
      if (data.limits) setProcessLimits(data.limits);
    } catch {
      /* ignore transient */
    } finally {
      if (showSpinner) setProcLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProcesses();
    const t = setInterval(() => void loadProcesses(), 5000);
    return () => clearInterval(t);
  }, [loadProcesses]);

  // Sidebar dots: which sessions have a pi process attached, and whether the
  // agent is working in it. Derived from the same poll as the process panel.
  const processStates = useMemo<Record<string, SessionProcessState>>(
    () => sessionProcessStates(processes),
    [processes],
  );

  const stopProcess = useCallback(
    async (sessionId: string | null, force: boolean) => {
      const what = sessionId === null ? "the server metadata process" : "this pi process";
      const question = force
        ? `Force kill ${what}? In-flight output is lost.`
        : `Stop ${what}? The next prompt respawns it.`;
      if (!confirm(question)) return;
      const key = sessionId ?? SERVER_PROCESS_KEY;
      setProcBusyKey(key);
      try {
        await pinion.processes.stop(sessionId, { force });
        await loadProcesses();
      } finally {
        setProcBusyKey(null);
      }
    },
    [loadProcesses],
  );

  // On mobile the sidebar is an overlay drawer — dismiss it on navigation.
  const closeDrawerOnMobile = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const refresh = useCallback(async () => {
    try {
      const list = await pinion.sessions.list();
      setSessions(list);
      if (!activeId && list.length > 0) {
        setActiveId(list[0].id);
      }
    } catch {
      /* ignore */
    }
  }, [activeId]);

  useEffect(() => {
    void refresh();
    void pinion.health
      .get()
      .then((health) => {
        setDefaultCwd(health.defaultCwd);
        setPiInfo({ piVersion: health.piVersion, piAvailable: health.piAvailable });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the sidebar preview fresh when switching sessions.
  useEffect(() => {
    if (!activeId) return;
    const t = setTimeout(() => void refresh(), 2500);
    return () => clearTimeout(t);
  }, [activeId, refresh]);

  // Cmd/Ctrl+Shift+E toggles the file browser, Cmd/Ctrl+Shift+G the git rail
  // (mirrors VS Code). Opening one swaps the shared right-side slot.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "e" && key !== "g") return;
      e.preventDefault();
      toggleRightPanel(key === "e" ? "files" : "git");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRightPanel]);

  const activeCwd = sessions.find((s) => s.id === activeId)?.cwd ?? "";

  const remove = async (id: string) => {
    if (!confirm("Delete this session? (pi's own session file is kept on disk)")) return;
    try {
      await pinion.sessions.delete(id);
    } catch {
      /* ignore */
    }
    setSessions((s) => s.filter((x) => x.id !== id));
    void refreshProjects();
    if (activeId === id) {
      const rest = sessions.filter((x) => x.id !== id);
      setActiveId(rest[0]?.id ?? null);
    }
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-app text-fg">
      {sidebarOpen === true && isMobile && (
        <div
          className="fixed inset-0 z-30 bg-overlay/60 backdrop-blur-[1px] md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}
      <Sidebar
        sessions={sessions}
        projects={projects}
        activeId={activeId}
        open={sidebarOpen}
        processStates={processStates}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => {
          setActiveId(id);
          closeDrawerOnMobile();
        }}
        onNew={() => {
          setNewModal({ cwd: defaultCwd });
          closeDrawerOnMobile();
        }}
        onNewInProject={(cwd) => {
          setNewModal({ cwd });
          closeDrawerOnMobile();
        }}
        onDelete={(id) => void remove(id)}
        onPinProject={pin}
        onUnpinProject={(p) => void unpin(p)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Slim top strip */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line/60 bg-app px-3 py-1.5">
          <button
            onClick={() => setSidebarOpen((prev) => nextSidebarUser(prev, isMobile))}
            className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-raised hover:text-fg"
            title="Toggle sidebar"
          >
            {/* CSS-owned so SSR and the first client render agree. */}
            <Menu size={15} className="md:hidden" />
            <PanelLeft size={15} className="hidden md:block" />
          </button>
          <span className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary text-primary-fg">
              <Bot size={13} />
            </span>
            Pinion
          </span>
          <span className="hidden text-[11px] text-fg-faint sm:inline">
            Pi agent console · {piInfo?.piVersion ?? "pi --mode rpc"}
          </span>
          {piInfo && !piInfo.piAvailable && (
            <span className="flex items-center gap-1 rounded-md bg-danger/10 px-2 py-0.5 text-[11px] text-danger-soft">
              <TriangleAlert size={11} /> pi binary not found — set PI_BINARY
            </span>
          )}
          <button
            type="button"
            onClick={() => toggleRightPanel("files")}
            disabled={!activeId}
            title="Toggle file browser"
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] transition disabled:opacity-40",
              rightPanel === "files"
                ? "bg-raised text-fg"
                : "text-fg-muted hover:bg-raised hover:text-fg",
            )}
          >
            <FolderTree size={13} />
            <span className="hidden sm:inline">Files</span>
          </button>
          <button
            type="button"
            onClick={() => toggleRightPanel("git")}
            disabled={!activeId}
            title="Toggle git changes"
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] transition disabled:opacity-40",
              rightPanel === "git"
                ? "bg-raised text-fg"
                : "text-fg-muted hover:bg-raised hover:text-fg",
            )}
          >
            <GitBranch size={13} />
            <span className="hidden sm:inline">Git</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setProcPanelOpen(true);
              void loadProcesses(true);
            }}
            title="Running pi processes"
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-fg-muted transition hover:bg-raised hover:text-fg"
          >
            <Activity size={13} />
            <span className="hidden sm:inline">Processes</span>
            {processes.length > 0 && (
              <span className="rounded-full bg-raised px-1.5 py-0.5 font-mono text-[10px] text-fg-secondary">
                {processes.length}
              </span>
            )}
          </button>
          <ThemeMenu />
        </div>

        {activeId ? (
          <div className="min-h-0 flex-1">
            <ChatView
              key={activeId}
              sessionId={activeId}
              onRenamed={() => {
                void refresh();
                void refreshProjects();
              }}
              onSessionCloned={(id) => {
                void refresh().then(() => setActiveId(id));
                void refreshProjects();
              }}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel">
                <Bot size={20} className="text-fg-secondary" />
              </div>
              <h2 className="text-[15px] font-semibold">No session selected</h2>
              <p className="mt-1 text-[12.5px] text-fg-subtle">Create one to start chatting with your Pi agent.</p>
              <button
                onClick={() => setNewModal({ cwd: defaultCwd })}
                className="mt-4 rounded-xl bg-primary px-4 py-2 text-[13px] font-medium text-primary-fg hover:bg-primary-hover"
              >
                New session
              </button>
            </div>
          </div>
        )}
      </div>
      {rightPanel === "files" && activeId && activeCwd && (
        <FileBrowser
          key={activeId}
          sessionId={activeId}
          cwd={activeCwd}
          mode={panelMode}
          onClose={closeRightPanel}
          onCollapse={() => setPanelMode("docked")}
          onExpand={() => setPanelMode("full")}
        />
      )}
      {rightPanel === "git" && activeId && activeCwd && (
        <GitPanel
          key={activeId}
          sessionId={activeId}
          cwd={activeCwd}
          mode={panelMode}
          onClose={closeRightPanel}
          onCollapse={() => setPanelMode("docked")}
          onExpand={() => setPanelMode("full")}
        />
      )}

      {procPanelOpen && (
        <ProcessPanel
          processes={processes}
          limits={processLimits}
          loading={procLoading}
          busyKey={procBusyKey}
          onStop={(id, force) => void stopProcess(id, force)}
          onRefresh={() => void loadProcesses(true)}
          onClose={() => setProcPanelOpen(false)}
        />
      )}

      {newModal && (
        <NewSessionModal
          defaultCwd={defaultCwd}
          initialCwd={newModal.cwd}
          suggestions={projects.map((p) => p.path)}
          onClose={() => setNewModal(null)}
          onCreated={(id) => {
            setNewModal(null);
            void refresh().then(() => setActiveId(id));
            void refreshProjects();
          }}
        />
      )}
    </div>
  );
}
