"use client";

import { useCallback, useEffect, useState } from "react";
import { pinion } from "@/lib/client";
import type { BrowseEntry, FilePreviewData } from "@/lib/file-browser";

export interface DirectoryListing {
  entries: BrowseEntry[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** One directory level of the session working directory (refetches on `dir`). */
export function useDirectoryListing(sessionId: string, dir: string): DirectoryListing {
  const [state, setState] = useState<{
    entries: BrowseEntry[];
    truncated: boolean;
    loading: boolean;
    error: string | null;
  }>({ entries: [], truncated: false, loading: true, error: null });
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    void (async () => {
      try {
        const data = await pinion.files.browse(sessionId, dir);
        if (cancelled) return;
        setState({
          entries: data.entries ?? [],
          truncated: Boolean(data.truncated),
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          entries: [],
          truncated: false,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load folder",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, dir, token]);

  const reload = useCallback(() => setToken((t) => t + 1), []);
  return { ...state, reload };
}

export interface PreviewState {
  data: FilePreviewData | null;
  loading: boolean;
  error: string | null;
}

/** Text preview for one path (null clears it — images skip this endpoint). */
export function useFilePreview(sessionId: string, path: string | null): PreviewState {
  const [state, setState] = useState<PreviewState>({ data: null, loading: false, error: null });

  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    void (async () => {
      try {
        const data = await pinion.files.preview(sessionId, path);
        if (cancelled) return;
        setState({ data, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load file",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  return state;
}
