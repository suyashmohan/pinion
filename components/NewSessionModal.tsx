"use client";

import { useEffect, useState } from "react";
import { FolderGit2, Loader2 } from "lucide-react";
import { pinion } from "@/lib/client";

export function NewSessionModal({
  defaultCwd,
  initialCwd,
  suggestions = [],
  onClose,
  onCreated,
}: {
  defaultCwd: string;
  initialCwd?: string;
  suggestions?: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(initialCwd || defaultCwd);
  const [touchedCwd, setTouchedCwd] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // defaultCwd loads async (health check); fill it in unless the user
  // already typed something or a project pre-selected the folder.
  useEffect(() => {
    if (!touchedCwd && !initialCwd && defaultCwd && !cwd) setCwd(defaultCwd);
  }, [defaultCwd, touchedCwd, initialCwd, cwd]);

  const create = async () => {
    if (!cwd.trim()) {
      setError("Working directory is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const session = await pinion.sessions.create({
        name: name.trim() || undefined,
        cwd: cwd.trim(),
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
      });
      setSaving(false);
      onCreated(session.id);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "Failed to create session");
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="fade-up w-full max-w-md overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <h3 className="text-[14px] font-semibold">New session</h3>
          <p className="mt-0.5 text-[12px] text-fg-subtle">
            Spawns a dedicated <span className="font-mono">pi --mode rpc</span> process.
          </p>
        </div>
        <div className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium text-fg-muted">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Refactor auth module"
              className="w-full rounded-xl border border-line-strong bg-app px-3 py-2 text-[13px] focus:border-line-focus focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center gap-1 text-[11.5px] font-medium text-fg-muted">
              <FolderGit2 size={11} /> Working directory (tool sandbox)
            </span>
            <input
              value={cwd}
              onChange={(e) => {
                setCwd(e.target.value);
                setTouchedCwd(true);
              }}
              list="pinion-project-folders"
              placeholder="/path/to/project"
              className="w-full rounded-xl border border-line-strong bg-app px-3 py-2 font-mono text-[12px] focus:border-line-focus focus:outline-none"
            />
            {suggestions.length > 0 && (
              <datalist id="pinion-project-folders">
                {suggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium text-fg-muted">Provider (optional)</span>
              <input
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="google"
                className="w-full rounded-xl border border-line-strong bg-app px-3 py-2 font-mono text-[12px] focus:border-line-focus focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium text-fg-muted">Model (optional)</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gemini-2.5-pro"
                className="w-full rounded-xl border border-line-strong bg-app px-3 py-2 font-mono text-[12px] focus:border-line-focus focus:outline-none"
              />
            </label>
          </div>
          {error && (
            <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger-soft">
              {error}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => void create()}
              disabled={saving}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-fg hover:bg-primary-hover disabled:opacity-60"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              Start session
            </button>
            <button
              onClick={onClose}
              className="rounded-xl border border-line-strong px-4 py-2.5 text-[13px] text-fg-secondary hover:bg-raised"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
