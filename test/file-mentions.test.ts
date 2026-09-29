/**
 * `@` file-mention helpers.
 *
 * Conventions match pi's own TUI completion: the `@` is *kept* in the
 * message (`@src/main.ts `), directories complete to `@src/` and navigate
 * the picker one level deeper, files complete with a trailing space. The
 * picker itself only ever browses inside the session working directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { $ } from "bun";
import {
  applyDirMention,
  applyFileMention,
  filterMentionEntries,
  mentionToken,
  normalizeMentionDir,
  parentMentionDir,
  sortMentionEntries,
  splitMentionPath,
  type MentionEntry,
} from "@/lib/file-mentions";
import { listMentionEntries, resolveWithinRoot } from "@/lib/files";
import { makeTempDir, removeTempDir } from "./helpers/test-env";

describe("mentionToken", () => {
  test("null when there is no @ at a token boundary", () => {
    expect(mentionToken("")).toBeNull();
    expect(mentionToken("/compact")).toBeNull();
    expect(mentionToken("a@b.com")).toBeNull(); // email, not a mention
    expect(mentionToken("hello @ src")).toBeNull(); // space closes the token
  });

  test("bare @ opens the picker at the project root", () => {
    expect(mentionToken("@")).toEqual({ start: 0, query: "" });
  });

  test("...and after any delimiter (space, quote, =)", () => {
    expect(mentionToken("look at @src/ma")).toEqual({ start: 8, query: "src/ma" });
    expect(mentionToken('"@src')).toEqual({ start: 1, query: "src" });
    expect(mentionToken("=@x")).toEqual({ start: 1, query: "x" });
  });

  test("only the token before the cursor counts", () => {
    expect(mentionToken("hi @src/main.ts tail", 7)).toEqual({ start: 3, query: "src" });
    expect(mentionToken("@x @y")).toEqual({ start: 3, query: "y" });
  });

  test("newlines end the token (paths never span lines)", () => {
    expect(mentionToken("hello\n@b")).toEqual({ start: 6, query: "b" });
    expect(mentionToken("@a\nmore")).toBeNull();
  });
});

describe("splitMentionPath / dir math", () => {
  test("splits the typed path into folder + filter", () => {
    expect(splitMentionPath("")).toEqual({ dir: "", filter: "" });
    expect(splitMentionPath("src")).toEqual({ dir: "", filter: "src" });
    expect(splitMentionPath("src/")).toEqual({ dir: "src/", filter: "" });
    expect(splitMentionPath("src/lib/co")).toEqual({ dir: "src/lib/", filter: "co" });
  });

  test("normalizes folder paths", () => {
    expect(normalizeMentionDir("")).toBe("");
    expect(normalizeMentionDir("src/")).toBe("src");
    expect(normalizeMentionDir("/src//")).toBe("src");
  });

  test("parent of a folder (empty string = project root)", () => {
    expect(parentMentionDir("")).toBe("");
    expect(parentMentionDir("src")).toBe("");
    expect(parentMentionDir("src/")).toBe("");
    expect(parentMentionDir("src/lib")).toBe("src");
    expect(parentMentionDir("src/lib/")).toBe("src");
  });
});

describe("completing a mention", () => {
  test("a file is inserted with the @ kept and a trailing space", () => {
    const token = mentionToken("hi @src/ma")!;
    expect(applyFileMention("hi @src/ma", token, 10, "src/main.ts")).toEqual({
      text: "hi @src/main.ts ",
      cursor: 16,
    });
  });

  test("a folder is inserted with a trailing slash and reopens the picker there", () => {
    const token = mentionToken("hi @sr")!;
    expect(applyDirMention("hi @sr", token, 6, "src")).toEqual({ text: "hi @src/", cursor: 8 });
  });

  test("walking up to the root leaves a bare @", () => {
    const token = mentionToken("hi @src/")!;
    expect(applyDirMention("hi @src/", token, 8, "")).toEqual({ text: "hi @", cursor: 4 });
  });

  test("text after the cursor is preserved", () => {
    const token = mentionToken("hi @sr please", 6)!;
    expect(applyDirMention("hi @sr please", token, 6, "src")).toEqual({
      text: "hi @src/ please",
      cursor: 8,
    });
  });
});

describe("resolveWithinRoot", () => {
  const root = "/tmp/pinion-mentions-root";
  test("resolves relative paths inside the root", () => {
    expect(resolveWithinRoot(root, "")).toBe(root);
    expect(resolveWithinRoot(root, "src")).toBe(path.join(root, "src"));
    expect(resolveWithinRoot(root, "src/lib/")).toBe(path.join(root, "src/lib"));
    expect(resolveWithinRoot(root, "src/../lib")).toBe(path.join(root, "lib"));
  });

  test("rejects anything that escapes the root", () => {
    expect(resolveWithinRoot(root, "..")).toBeNull();
    expect(resolveWithinRoot(root, "../etc")).toBeNull();
    expect(resolveWithinRoot(root, "src/../../etc")).toBeNull();
    expect(resolveWithinRoot(root, "/etc")).toBeNull();
  });
});

describe("entry sorting and filtering", () => {
  const entries: MentionEntry[] = [
    { name: "main.ts", type: "file", path: "main.ts" },
    { name: "domain.ts", type: "file", path: "domain.ts" },
    { name: "src", type: "dir", path: "src" },
    { name: "Assets", type: "dir", path: "Assets" },
  ];

  test("folders first, then files, case-insensitive alphabetical", () => {
    expect(sortMentionEntries(entries).map((e) => e.name)).toEqual([
      "Assets",
      "src",
      "domain.ts",
      "main.ts",
    ]);
  });

  test("filter is case-insensitive and prefix matches rank first", () => {
    expect(filterMentionEntries(entries, "").length).toBe(4);
    expect(filterMentionEntries(entries, "MA").map((e) => e.name)).toEqual(["main.ts", "domain.ts"]);
    expect(filterMentionEntries(entries, "zzz")).toEqual([]);
  });
});

describe("listMentionEntries (Bun fs)", () => {
  let root = "";

  test("lists folders and files, skips .git, keeps dotfiles, prefixes nested paths", async () => {
    root = await makeTempDir();
    await $`mkdir -p ${root}/src/lib ${root}/.hidden ${root}/.git`.quiet();
    await $`touch ${root}/README.md ${root}/.env ${root}/src/index.ts ${root}/src/lib/util.ts ${root}/.git/config`.quiet();

    const rootEntries = await listMentionEntries(root, "");
    expect(rootEntries.map((e) => `${e.type}:${e.path}`)).toEqual([
      "dir:.hidden",
      "dir:src",
      "file:.env",
      "file:README.md",
    ]);

    const srcEntries = await listMentionEntries(root, "src/");
    expect(srcEntries.map((e) => `${e.type}:${e.path}`)).toEqual([
      "dir:src/lib",
      "file:src/index.ts",
    ]);

    expect(await listMentionEntries(root, "src/lib")).toEqual([
      { name: "util.ts", type: "file", path: "src/lib/util.ts" },
    ]);
  });

  test("missing folders and escapes yield an empty list", async () => {
    expect(await listMentionEntries(root, "nope")).toEqual([]);
    expect(await listMentionEntries(root, "../")).toEqual([]);
  });

  afterAll(async () => {
    if (root) await removeTempDir(root);
  });
});
