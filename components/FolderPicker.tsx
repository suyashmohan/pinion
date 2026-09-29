"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Folder, FolderOpen, Loader2 } from "lucide-react";
import { pinion } from "@/lib/client";
import { cn } from "@/lib/utils";

export interface FolderEntry {
  name: string;
  path: string;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY: Listing = { path: "", parent: null, entries: [], loading: false, error: null };

/**
 * Path input with a visual folder browser.
 *
 * The panel is rendered in normal flow right below the input (not absolutely
 * positioned): the sidebar is a scroll container, so a floating popover would
 * be clipped at the fold. Clicking a folder walks into it and mirrors the
 * browsed path into the input, so the "Add project" button always adds the
 * folder that is on screen. Only directories are ever listed.
 */
export function FolderPicker({
  value,
  onChange,
  onSubmit,
  onEscape,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (path: string) => void;
  /** Enter in the input (adds the project). */
  onSubmit?: () => void;
  /** Escape while the picker is closed (cancels the add form). */
  onEscape?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing>(EMPTY);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const load = async (asked: string): Promise<string | null> => {
    setListing({ ...EMPTY, path: asked, loading: true });
    try {
      const data = await pinion.projects.listFolders(asked);
      setListing({
        path: data.path,
        parent: data.parent,
        entries: data.entries,
        loading: false,
        error: null,
      });
      return data.path;
    } catch (err) {
      setListing({
        ...EMPTY,
        path: asked,
        loading: false,
        error: err instanceof Error ? err.message : "Could not list folders",
      });
      return null;
    }
  };

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const resolved = await load(value);
    // An empty input adopts the resolved folder so it is obvious what Add uses.
    if (resolved && !value.trim()) onChange(resolved);
  };

  const navigate = async (path: string) => {
    onChange(path);
    await load(path);
  };

  const dirLabel = listing.path || value || "…";

  return (
    <div ref={ref}>
      <div className="relative">
        <input
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSubmit?.();
              return;
            }
            if (e.key === "Escape") {
              if (open) setOpen(false);
              else onEscape?.();
            }
          }}
          placeholder={placeholder}
          className="w-full rounded-lg border border-line-strong bg-app py-1.5 pl-2.5 pr-9 font-mono text-[12px] text-fg placeholder:text-fg-faint focus:border-line-focus focus:outline-none"
        />
        <button
          type="button"
          data-testid="folder-picker-toggle"
          onClick={() => void toggle()}
          aria-expanded={open}
          title={open ? "Hide folders" : "Browse folders"}
          aria-label={open ? "Hide folders" : "Browse folders"}
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 transition",
            open ? "bg-raised text-fg" : "text-fg-subtle hover:bg-raised hover:text-fg",
          )}
        >
          {open ? <FolderOpen size={13} /> : <Folder size={13} />}
        </button>
      </div>

      {open && (
        <div
          data-testid="folder-picker-panel"
          className="fade-up mt-1.5 overflow-hidden rounded-lg border border-line-strong/70 bg-app"
        >
          <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
            <button
              type="button"
              data-testid="folder-picker-up"
              onClick={() => listing.parent && void navigate(listing.parent)}
              disabled={!listing.parent}
              title="Go to parent folder"
              aria-label="Go to parent folder"
              className="rounded-md p-1 text-fg-subtle transition hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronUp size={13} />
            </button>
            <span className="truncate font-mono text-[10.5px] text-fg-subtle" title={dirLabel}>
              {dirLabel}
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto p-1">
            {listing.loading ? (
              <div className="flex items-center gap-1.5 px-2 py-3 text-[11.5px] text-fg-subtle">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : listing.error ? (
              <div className="px-2 py-3 text-[11.5px] text-warning-soft/90">{listing.error}</div>
            ) : listing.entries.length === 0 ? (
              <div className="px-2 py-3 text-[11.5px] text-fg-faint">No subfolders here.</div>
            ) : (
              listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  data-folder-path={entry.path}
                  onClick={() => void navigate(entry.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-raised"
                >
                  <Folder size={12} className="shrink-0 text-warning-soft/70" />
                  <span className="truncate font-mono text-[11.5px] text-fg-secondary">{entry.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
