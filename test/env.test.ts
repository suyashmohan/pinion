import { afterEach, describe, expect, test } from "bun:test";
import { defaultCwd, extraArgs, piBinary, piIdleTimeoutMs, piMaxProcesses, rpcTimeoutMs } from "@/lib/pi/env";

const saved = { ...process.env };

afterEach(() => {
  for (const k of ["PI_BINARY", "PI_DEFAULT_CWD", "PINION_DEFAULT_CWD", "PI_EXTRA_ARGS", "PI_RPC_TIMEOUT_MS", "PI_IDLE_TIMEOUT_MS", "PI_MAX_PI_PROCESSES"]) {
    delete process.env[k];
  }
  Object.assign(process.env, saved);
});

describe("piBinary", () => {
  test("defaults to pi, trims override", () => {
    expect(piBinary()).toBe("pi");
    process.env.PI_BINARY = "  /opt/pi  ";
    expect(piBinary()).toBe("/opt/pi");
  });
});

describe("defaultCwd", () => {
  test("prefers PI_DEFAULT_CWD, falls back to process.cwd()", () => {
    delete process.env.PI_DEFAULT_CWD;
    delete process.env.PINION_DEFAULT_CWD;
    expect(defaultCwd()).toBe(process.cwd());
    process.env.PI_DEFAULT_CWD = "/tmp/proj";
    expect(defaultCwd()).toBe("/tmp/proj");
  });
});

describe("extraArgs", () => {
  test("empty by default, shell-like split with quotes", () => {
    expect(extraArgs()).toEqual([]);
    process.env.PI_EXTRA_ARGS = '--provider google --model "my model" -x';
    expect(extraArgs()).toEqual(["--provider", "google", "--model", "my model", "-x"]);
  });
});

describe("rpcTimeoutMs", () => {
  test("default and invalid values fall back to 120s", () => {
    expect(rpcTimeoutMs()).toBe(120_000);
    process.env.PI_RPC_TIMEOUT_MS = "5000";
    expect(rpcTimeoutMs()).toBe(5000);
    process.env.PI_RPC_TIMEOUT_MS = "garbage";
    expect(rpcTimeoutMs()).toBe(120_000);
    process.env.PI_RPC_TIMEOUT_MS = "0";
    expect(rpcTimeoutMs()).toBe(120_000);
  });
});

describe("piIdleTimeoutMs", () => {
  test("defaults to 15min, explicit 0 disables, garbage falls back", () => {
    expect(piIdleTimeoutMs()).toBe(15 * 60_000);
    process.env.PI_IDLE_TIMEOUT_MS = "60000";
    expect(piIdleTimeoutMs()).toBe(60_000);
    process.env.PI_IDLE_TIMEOUT_MS = "0";
    expect(piIdleTimeoutMs()).toBe(0);
    process.env.PI_IDLE_TIMEOUT_MS = "garbage";
    expect(piIdleTimeoutMs()).toBe(15 * 60_000);
  });
});

describe("piMaxProcesses", () => {
  test("defaults to 10, explicit 0 means unlimited, garbage falls back", () => {
    expect(piMaxProcesses()).toBe(10);
    process.env.PI_MAX_PI_PROCESSES = "3";
    expect(piMaxProcesses()).toBe(3);
    process.env.PI_MAX_PI_PROCESSES = "0";
    expect(piMaxProcesses()).toBe(0);
    process.env.PI_MAX_PI_PROCESSES = "garbage";
    expect(piMaxProcesses()).toBe(10);
  });
});
