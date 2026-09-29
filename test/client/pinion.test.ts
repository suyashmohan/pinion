/**
 * PinionClient: 1:1 with the UI's HTTP calls, unwrapping where the UI wants
 * bare values. Fetch is injected so no network is touched.
 */
import { describe, expect, test } from "bun:test";
import { ClientError, PinionClient } from "@/lib/client/pinion";

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
}

function stubFetch(replies: Record<string, unknown>, calls: Call[]) {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
      credentials: init?.credentials,
    });
    const data = replies[`${method} ${url}`] ?? replies[url] ?? {};
    const status = data && typeof data === "object" && "__status" in (data as object)
      ? Number((data as { __status: number }).__status)
      : 200;
    const payload =
      status >= 400
        ? { ok: false, error: (data as { error?: string }).error ?? "failed" }
        : { ok: true, data };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const SESSION = {
  id: "s1",
  name: "one",
  cwd: "/tmp",
  provider: null,
  modelId: null,
  thinkingLevel: null,
  piSessionId: null,
  piSessionFile: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("PinionClient", () => {
  test("sessions.list unwraps data.sessions", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      fetch: stubFetch(
        { "GET /api/sessions": { sessions: [{ ...SESSION, preview: null, messageCount: 0 }] } },
        calls,
      ),
    });
    const list = await client.sessions.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("s1");
  });

  test("create unwraps data.session and POSTs the input", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      fetch: stubFetch({ "POST /api/sessions": { session: SESSION } }, calls),
    });
    const session = await client.sessions.create({ name: "x", cwd: "/tmp" });
    expect(session.id).toBe("s1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ name: "x", cwd: "/tmp" });
  });

  test("get returns the full payload; rename unwraps the row", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      fetch: stubFetch(
        {
          "GET /api/sessions/s1": {
            session: SESSION,
            state: null,
            stats: null,
            messages: [],
            liveError: null,
            live: false,
          },
          "PATCH /api/sessions/s1": { session: { ...SESSION, name: "two" } },
        },
        calls,
      ),
    });
    const detail = await client.sessions.get("s1");
    expect(detail.session.id).toBe("s1");
    expect(detail.live).toBe(false);
    expect((await client.sessions.rename("s1", "two")).name).toBe("two");
  });

  test("prompt/control/bash POST the expected JSON", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      fetch: stubFetch(
        {
          "POST /api/sessions/s1/prompt": { response: { type: "response", success: true } },
          "POST /api/sessions/s1/control": { response: null, live: false },
          "POST /api/sessions/s1/bash": { result: { output: "hi" } },
        },
        calls,
      ),
    });
    await client.sessions.prompt("s1", { message: "hello" });
    await client.sessions.control("s1", { action: "clear_queue" });
    await client.sessions.bash("s1", "ls");
    expect(calls[0]!.body).toEqual({ message: "hello" });
    expect(calls[1]!.body).toEqual({ action: "clear_queue" });
    expect(calls[2]!.body).toEqual({ command: "ls" });
  });

  test("delete issues DELETE and requires no body", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      fetch: stubFetch({ "DELETE /api/sessions/s1": { deleted: "s1" } }, calls),
    });
    await client.sessions.delete("s1");
    expect(calls[0]!.method).toBe("DELETE");
  });

  test("projects and processes", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      fetch: stubFetch(
        {
          "GET /api/projects": { projects: [] },
          "POST /api/processes/stop": { stopped: true },
        },
        calls,
      ),
    });
    expect(await client.projects.list()).toEqual([]);
    expect(await client.processes.stop("s1", { force: true })).toEqual({ stopped: true });
    expect(calls[1]!.body).toEqual({ id: "s1", force: true });
  });

  test("files.rawUrl stays a same-origin /api URL", () => {
    const client = new PinionClient({ fetch: stubFetch({}, []) });
    expect(client.files.rawUrl("s1", "a/b.png")).toBe(
      "/api/sessions/s1/files/raw?path=a%2Fb.png",
    );
    expect(client.files.rawUrl("s1", "a/b.png", { download: true })).toBe(
      "/api/sessions/s1/files/raw?path=a%2Fb.png&download=1",
    );
  });

  test("error envelopes become ClientError with the server message", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      fetch: stubFetch(
        { "GET /api/sessions/s1": { error: "Session not found", __status: 404 } },
        calls,
      ),
    });
    const err = await client.sessions.get("s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).message).toBe("Session not found");
  });

  test("token + baseUrl + credentials ride every request", async () => {
    const calls: Call[] = [];
    const client = new PinionClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "secret",
      fetch: stubFetch({ "GET http://127.0.0.1:3000/api/health": { app: "Pinion" } }, calls),
    });
    await client.health.get();
    expect(calls[0]!.url).toBe("http://127.0.0.1:3000/api/health");
    expect(calls[0]!.headers.Cookie).toBe("pinion_token=secret");
    expect(calls[0]!.credentials).toBe("include");
  });
});
