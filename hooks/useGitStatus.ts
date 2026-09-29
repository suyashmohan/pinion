"use client";

import { useCallback, useEffect, useState } from "react";
import { pinion } from "@/lib/client";
import type { GitStatusSnapshot } from "@/lib/git-status";

export interface GitStatusState {
  status: GitStatusSnapshot | null;
  /** First load for this session (no snapshot yet). */
  loading: boolean;
  /** A manual refresh is in flight — drives the header spinner. */
  refreshing: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Working-tree change summary for the active session. Refetches on session
 * change, on demand (refresh button) and on a slow poll while the rail is
 * open, so agent edits show up without a manual reload. Background polls are
 * quiet: the previous snapshot stays visible and the spinner does not blink.
 */
export function useGitStatus(sessionId: string, pollMs = 5000): GitStatusState {
  const [state, setState] = useState<{
    status: GitStatusSnapshot | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
  }>({ status: null, loading: true, refreshing: false, error: null });
  const [token, setToken] = useState(0);

  // Session switch: drop the previous repo's files immediately.
  useEffect(() => {
    setState({ status: null, loading: true, refreshing: false, error: null });
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({
      ...prev,
      loading: prev.status === null,
      error: null,
    }));
    void (async () => {
      try {
        const status = await pinion.git.status(sessionId);
        if (cancelled) return;
        setState({ status, loading: false, refreshing: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          status: prev.status,
          loading: false,
          refreshing: false,
          error: err instanceof Error ? err.message : "Failed to load git changes",
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, token]);

  useEffect(() => {
    if (!(pollMs > 0)) return;
    const t = setInterval(() => setToken((v) => v + 1), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);

  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, refreshing: true }));
    setToken((v) => v + 1);
  }, []);

  return { ...state, reload };
}
