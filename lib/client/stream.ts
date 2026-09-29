/**
 * Browser SSE transport for the SDK.
 *
 * The server emits **named** events (`event: agent_start` …); per the SSE spec
 * those never reach `onmessage`, so a listener must be registered per name.
 * Each subscription owns one `Projector` and emits snapshot `SessionEvent`s.
 *
 * Token note: native `EventSource` cannot set a `Cookie` header. Loopback
 * clients (`opts.token`) need an EventSource polyfill that injects the cookie,
 * or they should hit `GET ${baseUrl}/?token=` once so the cookie jar has
 * `pinion_token`. This effort does not ship that polyfill; the option is not a
 * dead end.
 */

import { PI_SSE_EVENT_TYPES } from "./sse-names";
import { createProjector, pushPiEvent } from "@/lib/control/projector";
import type { SessionEvent, Unsubscribe } from "@/lib/control/types";

export interface SessionStreamOptions {
  baseUrl?: string;
  EventSource?: typeof EventSource;
  token?: string;
  /** Called when the browser gives up retrying (readyState CLOSED). */
  onClose?: () => void;
}

export function sessionStreamUrl(sessionId: string, baseUrl = ""): string {
  return `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/stream`;
}

export function subscribeSession(
  sessionId: string,
  listener: (ev: SessionEvent) => void,
  opts: SessionStreamOptions = {},
): Unsubscribe {
  const ES =
    opts.EventSource ??
    (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource;
  if (typeof ES !== "function") {
    throw new Error("EventSource is not available in this runtime");
  }

  const projector = createProjector();
  const es = new ES(sessionStreamUrl(sessionId, opts.baseUrl ?? ""), {
    withCredentials: true,
  } as never);

  const handler = (e: MessageEvent) => {
    let ev: { type: string } & Record<string, unknown>;
    try {
      ev = JSON.parse(String(e.data)) as { type: string } & Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof ev.type !== "string") return;
    for (const sessionEvent of pushPiEvent(projector, ev)) listener(sessionEvent);
  };

  const eventListener = handler as unknown as EventListener;
  for (const name of PI_SSE_EVENT_TYPES) es.addEventListener(name, eventListener);
  es.onmessage = handler; // fallback for any unnamed events
  es.onerror = () => {
    // EventSource auto-reconnects on transient failures. Only report the
    // stream as down when the browser gives up retrying (CLOSED = 2).
    if (es.readyState === 2) opts.onClose?.();
  };

  return () => {
    for (const name of PI_SSE_EVENT_TYPES) es.removeEventListener(name, eventListener);
    es.close();
  };
}
