import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { $ } from "bun";
import { dirExists, hasSqlMigrations, listSubdirectories, resolveBrowseDir } from "@/lib/files";
import { makeTempDir, removeTempDir } from "./helpers/test-env";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await removeTempDir(d);
});

describe("dirExists", () => {
  test("true for directories, false for missing paths and files", async () => {
    expect(await dirExists("/tmp")).toBe(true);
    expect(await dirExists("/nope-missing-dir-pinion-xyz")).toBe(false);
    // this test file itself is a file, not a directory
    expect(await dirExists(new URL("./files.test.ts", import.meta.url).pathname)).toBe(false);
  });
});

describe("hasSqlMigrations", () => {
  test("detects *.sql files", async () => {
    const withSql = await makeTempDir();
    const empty = await makeTempDir();
    dirs.push(withSql, empty);
    await Bun.write(`${withSql}/0001_init.sql`, "select 1;");
    expect(await hasSqlMigrations(withSql)).toBe(true);
    expect(await hasSqlMigrations(empty)).toBe(false);
    expect(await hasSqlMigrations("/nope-missing-dir-pinion-xyz")).toBe(false);
  });
});

describe("resolveBrowseDir (sidebar folder picker)", () => {
  test("keeps an existing directory", async () => {
    const root = await makeTempDir();
    dirs.push(root);
    const child = path.join(root, "project");
    await $`mkdir -p ${child}`.quiet();
    expect(await resolveBrowseDir(child, "/")).toBe(child);
    expect(await resolveBrowseDir(root, "/")).toBe(root);
  });

  test("falls back to the parent for partial paths and files", async () => {
    const root = await makeTempDir();
    dirs.push(root);
    const child = path.join(root, "project");
    await $`mkdir -p ${child}`.quiet();
    await $`touch ${root}/README.md`.quiet();
    expect(await resolveBrowseDir(path.join(child, "typo"), "/")).toBe(child);
    expect(await resolveBrowseDir(path.join(root, "README.md"), "/")).toBe(root);
  });

  test("falls back when the input is empty or unusable", async () => {
    const home = await makeTempDir();
    dirs.push(home);
    expect(await resolveBrowseDir("", home)).toBe(home);
    expect(await resolveBrowseDir("  ", home)).toBe(home);
    expect(await resolveBrowseDir("/nope-missing-pinion-xyz", home)).toBe(home);
    expect(await resolveBrowseDir("", "/nope-missing-pinion-xyz")).toBe("/");
  });
});

describe("listSubdirectories (folders only)", () => {
  test("keeps directories, skips files, sorts case-insensitively", async () => {
    const root = await makeTempDir();
    dirs.push(root);
    await $`mkdir -p ${root}/zebra ${root}/Alpha ${root}/.hidden`.quiet();
    await $`touch ${root}/file.txt ${root}/readme.md`.quiet();
    expect(await listSubdirectories(root)).toEqual([
      { name: ".hidden", path: `${root}/.hidden` },
      { name: "Alpha", path: `${root}/Alpha` },
      { name: "zebra", path: `${root}/zebra` },
    ]);
  });

  test("missing paths and plain files yield an empty list", async () => {
    expect(await listSubdirectories("/nope-missing-dir-pinion-xyz")).toEqual([]);
    expect(await listSubdirectories(new URL("./files.test.ts", import.meta.url).pathname)).toEqual([]);
  });
});
