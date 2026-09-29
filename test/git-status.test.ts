/**
 * Git change summary — pure parsers, `readGitStatus` against real repos in
 * temp dirs, and the `GET …/git` route.
 *
 * The panel lists changed files with added/removed line counts only (no diff
 * text), so the contract here is: porcelain status codes, rename/copy source
 * paths, staged-vs-worktree flags, binary counts as null, untracked line
 * counts read from disk, truncation, and a clean `isRepo: false` signal
 * (never an error) for a folder that is not inside a git working tree.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sessions as sessionsTable } from "@/lib/db/schema";
import {
  applyUntrackedLines,
  buildChangedFiles,
  changeKindFromCode,
  parseNumstatZ,
  parsePorcelainZ,
  statusLetter,
  sumLineChanges,
  type GitStatusEntry,
} from "@/lib/git-status";
import { readGitStatus } from "@/lib/git";
import { GET as gitGET } from "@/app/api/sessions/[id]/git/route";
import { cleanupDbs, freshDb, makeTempDir, removeTempDir, uniqueId } from "./helpers/test-env";

/** `git status --porcelain -z` style payload from logical records. */
function z(...records: string[]): string {
  return records.length === 0 ? "" : `${records.join("\0")}\0`;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
}

async function initRepo(): Promise<string> {
  const dir = await makeTempDir();
  await git(dir, "init", "-q");
  await git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(dir, "config", "user.email", "pinion@test");
  await git(dir, "config", "user.name", "Pinion Test");
  return dir;
}

const dirs: string[] = [];

describe("parsePorcelainZ", () => {
  test("parses status codes, paths and rename/copy sources", () => {
    const entries = parsePorcelainZ(
      z(
        " M src/app.ts",
        "M  staged.ts",
        "MM both.ts",
        "A  added.ts",
        " D gone.ts",
        "D  staged-gone.ts",
        "R  renamed-new.ts",
        "renamed-old.ts",
        "C  copied.ts",
        "copy-source.ts",
        "?? untracked.ts",
        "UU conflict.ts",
        " M file with space.ts",
      ),
    );
    expect(entries).toEqual<GitStatusEntry[]>([
      { code: " M", path: "src/app.ts", origPath: null },
      { code: "M ", path: "staged.ts", origPath: null },
      { code: "MM", path: "both.ts", origPath: null },
      { code: "A ", path: "added.ts", origPath: null },
      { code: " D", path: "gone.ts", origPath: null },
      { code: "D ", path: "staged-gone.ts", origPath: null },
      { code: "R ", path: "renamed-new.ts", origPath: "renamed-old.ts" },
      { code: "C ", path: "copied.ts", origPath: "copy-source.ts" },
      { code: "??", path: "untracked.ts", origPath: null },
      { code: "UU", path: "conflict.ts", origPath: null },
      { code: " M", path: "file with space.ts", origPath: null },
    ]);
  });

  test("skips ignored entries and tolerates empty input", () => {
    expect(parsePorcelainZ("")).toEqual([]);
    expect(parsePorcelainZ(z("!! ignored.txt", " M kept.ts"))).toEqual([
      { code: " M", path: "kept.ts", origPath: null },
    ]);
  });
});

describe("parseNumstatZ", () => {
  test("maps counts by path, handles binaries and renames", () => {
    const map = parseNumstatZ(
      z("3\t1\tsrc/app.ts", "-\t-\tbinary.bin", "0\t0\t", "old-name.ts", "new-name.ts"),
    );
    expect(map.get("src/app.ts")).toEqual({ added: 3, removed: 1 });
    expect(map.get("binary.bin")).toEqual({ added: null, removed: null });
    // Renames are keyed by their new path.
    expect(map.get("new-name.ts")).toEqual({ added: 0, removed: 0 });
    expect(map.has("old-name.ts")).toBe(false);
  });

  test("tolerates empty input", () => {
    expect(parseNumstatZ("").size).toBe(0);
  });
});

describe("changeKindFromCode / statusLetter", () => {
  test("classifies both index and worktree states", () => {
    expect(changeKindFromCode(" M")).toBe("modified");
    expect(changeKindFromCode("M ")).toBe("modified");
    expect(changeKindFromCode("MM")).toBe("modified");
    expect(changeKindFromCode("T ")).toBe("modified");
    expect(changeKindFromCode("A ")).toBe("added");
    expect(changeKindFromCode(" D")).toBe("deleted");
    expect(changeKindFromCode("R ")).toBe("renamed");
    expect(changeKindFromCode("C ")).toBe("copied");
    expect(changeKindFromCode("??")).toBe("untracked");
    expect(changeKindFromCode("UU")).toBe("conflicted");
    expect(changeKindFromCode("AA")).toBe("conflicted");
    expect(changeKindFromCode("DD")).toBe("conflicted");
    expect(changeKindFromCode("XY")).toBe("unknown");
  });

  test("letters match the conventional source-control badges", () => {
    expect(statusLetter("modified")).toBe("M");
    expect(statusLetter("added")).toBe("A");
    expect(statusLetter("deleted")).toBe("D");
    expect(statusLetter("renamed")).toBe("R");
    expect(statusLetter("copied")).toBe("C");
    expect(statusLetter("untracked")).toBe("U");
    expect(statusLetter("conflicted")).toBe("!");
    expect(statusLetter("unknown")).toBe("?");
  });
});

describe("buildChangedFiles", () => {
  test("merges status codes with numstat counts and flags", () => {
    const entries = parsePorcelainZ(
      z(" M src/app.ts", "MM both.ts", "A  added.ts", " D gone.ts", "?? fresh.ts", "?? binary.bin"),
    );
    const numstat = parseNumstatZ(z("2\t1\tsrc/app.ts", "5\t5\tboth.ts", "9\t0\tadded.ts", "0\t3\tgone.ts"));
    const files = applyUntrackedLines(
      buildChangedFiles(entries, numstat),
      new Map([["fresh.ts", 4]]),
    );

    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("src/app.ts")).toMatchObject({
      kind: "modified",
      staged: false,
      unstaged: true,
      added: 2,
      removed: 1,
    });
    expect(byPath.get("both.ts")).toMatchObject({
      kind: "modified",
      staged: true,
      unstaged: true,
      added: 5,
      removed: 5,
    });
    expect(byPath.get("added.ts")).toMatchObject({ kind: "added", staged: true, unstaged: false });
    expect(byPath.get("gone.ts")).toMatchObject({ kind: "deleted", staged: false, added: 0, removed: 3 });
    expect(byPath.get("fresh.ts")).toMatchObject({
      kind: "untracked",
      staged: false,
      unstaged: true,
      added: 4,
      removed: 0,
    });
    // No numstat entry and no untracked line count: counts stay unknown.
    expect(byPath.get("binary.bin")).toMatchObject({ added: null, removed: null });
  });

  test("folds an undetected rename's old-path stats into the new entry", () => {
    // `git status` pairs the rename explicitly while `git diff` (below its
    // similarity threshold) reports two independent paths.
    const entries = parsePorcelainZ(z("RM renamed.ts", "old.ts"));
    const numstat = parseNumstatZ(z("3\t0\trenamed.ts", "0\t1\told.ts"));
    const files = buildChangedFiles(entries, numstat);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "renamed.ts", origPath: "old.ts", kind: "renamed", added: 3, removed: 1 });
  });

  test("folds a staged delete plus a recreated untracked file into one row", () => {
    // `git rm --cached f` leaves the file on disk, so porcelain emits `D  f`
    // and `?? f` for the same path. Two rows would duplicate React keys and
    // double-count the same numstat into the totals.
    const entries = parsePorcelainZ(z("D  f.txt", "?? f.txt"));
    const files = buildChangedFiles(entries, parseNumstatZ(z("0\t1\tf.txt")));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "f.txt",
      origPath: null,
      // The worktree record describes what is on disk now.
      kind: "untracked",
      staged: true,
      unstaged: true,
    });
  });

  test("keeps binary untracked files unknown and sorts by path", () => {
    const entries = parsePorcelainZ(z("?? z.txt", "?? a.bin", " M m.ts"));
    const files = applyUntrackedLines(
      buildChangedFiles(entries, new Map()),
      new Map<string, number | null>([
        ["z.txt", 2],
        ["a.bin", null],
      ]),
    );
    expect(files.map((f) => f.path)).toEqual(["a.bin", "m.ts", "z.txt"]);
    expect(files[0]).toMatchObject({ added: null, removed: null });
    expect(files[2]).toMatchObject({ added: 2, removed: 0 });
  });
});

describe("sumLineChanges", () => {
  test("sums numeric counts and ignores binary unknowns", () => {
    expect(
      sumLineChanges([
        { path: "a", origPath: null, kind: "modified", staged: false, unstaged: true, added: 2, removed: 1 },
        { path: "b", origPath: null, kind: "untracked", staged: false, unstaged: true, added: null, removed: null },
        { path: "c", origPath: null, kind: "added", staged: true, unstaged: false, added: 3, removed: 0 },
      ]),
    ).toEqual({ added: 5, removed: 1 });
  });
});

describe("readGitStatus", () => {
  test("reports a non-repo folder instead of erroring", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const status = await readGitStatus(dir);
    expect(status).toMatchObject({ isRepo: false, files: [], branch: null, error: null });
  });

  test("reports a missing working directory with an error", async () => {
    const status = await readGitStatus("/tmp/pinion-definitely-missing-dir");
    expect(status.isRepo).toBe(false);
    expect(status.error).toBeTruthy();
  });

  test("surfaces a git spawn failure as an error", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const status = await readGitStatus(dir, {
      run: async () => ({ ok: false, code: null, stdout: "", stderr: "git is not available" }),
    });
    expect(status.isRepo).toBe(false);
    expect(status.error).toBe("git is not available");
  });

  test("lists uncommitted changes with counts, binary unknowns and totals", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await Bun.write(`${dir}/a.txt`, "one\ntwo\nthree\n");
    await Bun.write(`${dir}/gone.txt`, "bye\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");

    await Bun.write(`${dir}/a.txt`, "one\nTWO\nthree\nfour\n");
    await $`rm -f ${dir}/gone.txt`.quiet();
    await Bun.write(`${dir}/untracked.txt`, "u1\nu2\n");
    await Bun.write(`${dir}/blob.bin`, new Uint8Array([0x00, 0x01, 0x02]));

    const status = await readGitStatus(dir);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.error).toBeNull();
    expect(status.truncated).toBe(false);
    expect(status.files.map((f) => f.path)).toEqual(["a.txt", "blob.bin", "gone.txt", "untracked.txt"]);

    const byPath = new Map(status.files.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")).toMatchObject({
      kind: "modified",
      staged: false,
      unstaged: true,
      added: 2,
      removed: 1,
    });
    expect(byPath.get("gone.txt")).toMatchObject({ kind: "deleted", added: 0, removed: 1 });
    expect(byPath.get("untracked.txt")).toMatchObject({ kind: "untracked", added: 2, removed: 0 });
    expect(byPath.get("blob.bin")).toMatchObject({ kind: "untracked", added: null, removed: null });
    expect({ added: status.added, removed: status.removed }).toEqual({ added: 4, removed: 2 });
  });

  test("flags staged-only changes and detects renames", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await Bun.write(`${dir}/old.txt`, "one\ntwo\nthree\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");

    await git(dir, "mv", "old.txt", "renamed.txt");
    await Bun.write(`${dir}/staged.txt`, "fresh\n");
    await git(dir, "add", "staged.txt");

    const status = await readGitStatus(dir);
    const byPath = new Map(status.files.map((f) => [f.path, f]));
    expect(byPath.get("staged.txt")).toMatchObject({ kind: "added", staged: true, unstaged: false });
    expect(byPath.get("renamed.txt")).toMatchObject({
      kind: "renamed",
      origPath: "old.txt",
      staged: true,
      unstaged: false,
    });
  });

  test("does not duplicate a path that is staged-deleted and untracked", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await Bun.write(`${dir}/f.txt`, "hi\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");
    // Index deletion, worktree file kept: git reports `D  f.txt` + `?? f.txt`.
    await git(dir, "rm", "-q", "--cached", "f.txt");

    const status = await readGitStatus(dir, { limit: 1 });
    expect(status.files.map((f) => f.path)).toEqual(["f.txt"]);
    expect(status.files[0]).toMatchObject({
      kind: "untracked",
      staged: true,
      unstaged: true,
      added: 1,
      removed: 0,
    });
    expect(status.added).toBe(1);
    expect(status.removed).toBe(0);
    // One real file, so a limit of 1 is not a truncated list.
    expect(status.truncated).toBe(false);
  });

  test("handles a repo without commits (unborn HEAD)", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await Bun.write(`${dir}/fresh.txt`, "a\nb\nc\n");

    const status = await readGitStatus(dir, { limit: 10 });
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({ path: "fresh.txt", kind: "untracked", added: 3, removed: 0 });
  });

  test("works from a subdirectory and reports repo-relative paths", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await Bun.write(`${dir}/sub/f.txt`, "a\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");
    await Bun.write(`${dir}/sub/f.txt`, "a\nb\n");

    const status = await readGitStatus(`${dir}/sub`);
    expect(status.isRepo).toBe(true);
    expect(status.files.map((f) => f.path)).toEqual(["sub/f.txt"]);
    expect(status.files[0]).toMatchObject({ added: 1, removed: 0 });
  });

  test("truncates long change lists at the limit", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await Bun.write(`${dir}/a.txt`, "a\n");
    await Bun.write(`${dir}/b.txt`, "b\n");
    await Bun.write(`${dir}/c.txt`, "c\n");

    const status = await readGitStatus(dir, { limit: 2 });
    expect(status.files).toHaveLength(2);
    expect(status.truncated).toBe(true);
  });
});

describe("GET …/git", () => {
  let sessionId = "";
  let repo = "";

  beforeAll(async () => {
    repo = await initRepo();
    dirs.push(repo);
    await Bun.write(`${repo}/README.md`, "# hi\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "init");
    await Bun.write(`${repo}/README.md`, "# hi\nmore\n");
  });

  beforeEach(async () => {
    await freshDb();
    sessionId = uniqueId("git-sess");
    const now = Date.now();
    await (await getDb())
      .insert(sessionsTable)
      .values({ id: sessionId, name: "git-test", cwd: repo, createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(async () => {
    await (await getDb()).delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
  });

  test("returns the change summary for the session working directory", async () => {
    const res = await gitGET(new Request("http://localhost/api/test"), {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { isRepo: boolean; files: Array<{ path: string }> } };
    expect(body.ok).toBe(true);
    expect(body.data.isRepo).toBe(true);
    expect(body.data.files.map((f) => f.path)).toEqual(["README.md"]);
  });

  test("404s on unknown sessions", async () => {
    const res = await gitGET(new Request("http://localhost/api/test"), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });
});

afterAll(async () => {
  await cleanupDbs();
  for (const d of dirs.splice(0)) await removeTempDir(d);
});
