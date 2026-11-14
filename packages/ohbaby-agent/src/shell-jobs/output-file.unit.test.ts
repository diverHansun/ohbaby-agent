import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellJobRegistry, type ShellJobSnapshot } from "./registry.js";

class Child extends EventEmitter {
  readonly pid = 42;
  readonly stdin = { end: vi.fn() };
  readonly stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
}
describe("shell output files", () => {
  let directory: string;
  let child: Child;
  let registry: ShellJobRegistry;
  beforeEach(async () => {
    directory = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), "ohbaby-shell-log-")),
    );
    child = new Child();
    registry = new ShellJobRegistry({
      createJobId: (): string => "job",
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
      probeTree: (): "stopped" => "stopped",
      outputDrainMs: 10,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await registry.dispose();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  function start(): Promise<ShellJobSnapshot> {
    return registry.start({
      child: () => child as unknown as ChildProcess,
      sessionId: "session",
      timeoutMs: 1000,
      outputDirectory: directory,
    });
  }
  function close(): void {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  }
  it("writes raw split UTF-8 and both streams before publishing a complete pointer", async () => {
    await start();
    const bytes = Buffer.from("😀");
    child.stdout.emit("data", Buffer.from("a".repeat(40_000)));
    child.stdout.emit("data", bytes.subarray(0, 2));
    child.stdout.emit("data", bytes.subarray(2));
    child.stderr.emit("data", Buffer.from("stderr-tail"));
    expect(registry.get("job", "session").metadata.outputFile).toMatchObject({
      status: "in-progress",
    });
    close();
    const result = await registry.waitForTerminal("job", "session");
    expect(result.metadata.outputFile).toMatchObject({
      status: "full",
      path: path.join(directory, "job.log"),
    });
    expect(await fsp.readFile(path.join(directory, "job.log"), "utf8")).toBe(
      "a".repeat(40_000) + "😀stderr-tail",
    );
  });
  it("retains a partial file within 10 MiB, including its marker, at a multibyte boundary", async () => {
    await start();
    child.stdout.emit("data", Buffer.from("😀".repeat(3_000_000)));
    child.stderr.emit("data", Buffer.from("unpersisted-tail"));
    close();
    const result = registry.get("job", "session");
    expect(result.status).toBe("completed");
    expect(result.metadata.outputFile).toMatchObject({
      status: "partial",
      reason: "size-limit",
    });
    expect(result.output).toContain("Partial output");
    const bytes = await fsp.readFile(path.join(directory, "job.log"));
    expect(bytes.length).toBeLessThanOrEqual(10_485_760);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(text).toContain("output truncated");
    expect(text).not.toContain("unpersisted-tail");
  });
  it("does not label a logical cancellation complete before late stdio closes", async () => {
    await start();
    child.stdout.emit("data", "a".repeat(40_000));
    const killed = await registry.kill("job", "session");
    expect(killed.status).toBe("cancelled");
    expect(killed.metadata.outputFile).toMatchObject({ status: "partial" });
    expect(killed.output).not.toContain("Full output");
    child.stderr.emit("data", Buffer.from("late-stream"));
    child.emit("close", null, "SIGTERM");
    const final = registry.get("job", "session");
    expect(final.metadata.outputFile).toMatchObject({ status: "partial" });
    expect(
      await fsp.readFile(path.join(directory, "job.log"), "utf8"),
    ).toContain("late-stream");
  });
  it("ends an abandoned split UTF-8 character before its incomplete marker", async () => {
    await start();
    child.stdout.emit("data", "a".repeat(40_000));
    child.stdout.emit("data", Buffer.from("😀").subarray(0, 2));
    await expect(registry.dispose()).rejects.toThrow("unconfirmed");
    const bytes = await fsp.readFile(path.join(directory, "job.log"));
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ).not.toThrow();
    expect(bytes.toString("utf8")).toContain("output incomplete");
    child.emit("close", 0, null);
  });
  it("keeps exactly 10 MiB complete and handles short filesystem writes", async () => {
    const write = fs.writeSync.bind(fs);
    vi.spyOn(fs, "writeSync").mockImplementation(
      (...args: unknown[]): number => {
        const [fd, buffer, offset, length, position] = args;
        if (
          typeof fd !== "number" ||
          !Buffer.isBuffer(buffer) ||
          typeof offset !== "number" ||
          typeof length !== "number" ||
          typeof position !== "number"
        )
          throw new Error("Unexpected write signature");
        return write(fd, buffer, offset, Math.min(length, 16_384), position);
      },
    );
    await start();
    child.stdout.emit("data", Buffer.alloc(10_485_760, 120));
    close();
    expect(registry.get("job", "session").metadata.outputFile).toMatchObject({
      status: "full",
      sizeBytes: 10_485_760,
    });
    const bytes = await fsp.readFile(path.join(directory, "job.log"));
    expect(bytes.length).toBe(10_485_760);
    expect(bytes.every((byte) => byte === 120)).toBe(true);
  });
  it("caps the first byte beyond exactly 10 MiB and closes its writer", async () => {
    const fd = observeLogDescriptor();
    await start();
    child.stdout.emit("data", Buffer.alloc(10_485_760, 120));
    child.stdout.emit("data", Buffer.from("!"));
    expect(() => fs.fstatSync(fd())).toThrow(/bad file descriptor|EBADF/i);
    close();
    const file = await fsp.readFile(path.join(directory, "job.log"));
    expect(file.length).toBe(10_485_760);
    expect(file.toString("utf8")).toContain("output truncated");
    expect(registry.get("job", "session").metadata.outputFile).toMatchObject({
      status: "partial",
      reason: "size-limit",
    });
  });
  function observeLogDescriptor(match = "job.log"): () => number {
    const open = fs.openSync.bind(fs);
    let descriptor: number | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode): number => {
      const fd = open(file, flags, mode);
      if (String(file).endsWith(match)) descriptor = fd;
      return fd;
    });
    return (): number => {
      if (descriptor === undefined) throw new Error("Log did not open");
      return descriptor;
    };
  }
  it("releases the descriptor on dispose even when process cleanup remains unconfirmed", async () => {
    registry = new ShellJobRegistry({
      createJobId: (): string => "job",
      killTree: (): {
        status: "unconfirmed";
        reason: "observation-expired";
      } => ({ status: "unconfirmed", reason: "observation-expired" }),
      probeTree: (): "running" => "running",
    });
    const fd = observeLogDescriptor();
    await start();
    child.stdout.emit("data", "x".repeat(40_000));
    await expect(registry.dispose()).rejects.toThrow("cleanup is unconfirmed");
    expect(() => fs.fstatSync(fd())).toThrow(/bad file descriptor|EBADF/i);
    const before = await fsp.readFile(path.join(directory, "job.log"));
    child.stdout.emit("data", "too-late");
    expect(await fsp.readFile(path.join(directory, "job.log"))).toEqual(before);
    expect(registry.get("job", "session").metadata.outputFile).toMatchObject({
      status: "partial",
    });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    registry = new ShellJobRegistry({ killTree: vi.fn() });
  });
  it("retains responsibility for an unfinished log until its output drains", async () => {
    let next = 0;
    registry = new ShellJobRegistry({
      createJobId: (): string => `job-${String(next++)}`,
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
      probeTree: (): "stopped" => "stopped",
      outputDrainMs: 1000,
    });
    const fd = observeLogDescriptor("job-0.log");
    await start();
    child.stdout.emit("data", "x".repeat(40_000));
    await registry.kill("job-0", "session");
    for (let index = 0; index < 100; index++) {
      const later = new Child();
      await registry.start({
        child: () => later as unknown as ChildProcess,
        sessionId: "session",
        timeoutMs: 1000,
        outputDirectory: directory,
      });
      later.emit("exit", 0, null);
      later.emit("close", 0, null);
    }
    expect(registry.get("job-0", "session").status).toBe("cancelled");
    expect(fs.fstatSync(fd()).isFile()).toBe(true);
    const file = path.join(directory, "job-0.log");
    const before = await fsp.readFile(file);
    expect(before.toString("utf8")).toContain("x");
    child.emit("close", 0, null);
    expect(() => fs.fstatSync(fd())).toThrow(/bad file descriptor|EBADF/i);
  });
  it("closes an incomplete log when the existing output-drain budget expires", async () => {
    await start();
    child.stdout.emit("data", "a".repeat(40_000));
    child.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const result = registry.get("job", "session");
    expect(result.status).toBe("completed");
    expect(result.metadata.outputFile).toMatchObject({
      status: "partial",
      reason: "stdio-incomplete",
    });
    const before = await fsp.readFile(path.join(directory, "job.log"));
    child.stdout.emit("data", "ignored-late");
    child.emit("close", 0, null);
    expect(await fsp.readFile(path.join(directory, "job.log"))).toEqual(before);
    expect(registry.get("job", "session").output).not.toContain("Full output");
  });
  it.each(["openSync", "writeSync", "closeSync"] as const)(
    "keeps command success truthful after %s fails",
    async (method) => {
      const original = fs[method];
      let failed = false;
      vi.spyOn(fs, method).mockImplementationOnce((...args: unknown[]) => {
        failed = true;
        if (method === "closeSync") Reflect.apply(original, fs, args);
        throw new Error("disk failure");
      });
      await start();
      child.stdout.emit("data", "a".repeat(40_000));
      close();
      const result = registry.get("job", "session");
      expect(failed).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.metadata.outputFile).toEqual({ status: "unavailable" });
      expect(result.output).toContain("could not be saved");
      expect(result.output).not.toContain("saved to");
    },
  );
  it("stops writing after a partial write failure and releases its descriptor", async () => {
    const fd = observeLogDescriptor();
    await start();
    child.stdout.emit("data", Buffer.from("saved-prefix"));
    vi.spyOn(fs, "writeSync").mockImplementationOnce((): number => {
      throw new Error("disk full");
    });
    child.stdout.emit("data", "x".repeat(40_000));
    child.stderr.emit("data", "not-written-after-failure");
    close();
    const result = registry.get("job", "session");
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.metadata.outputFile).toEqual({ status: "unavailable" });
    expect(result.output).toContain("could not be saved");
    expect(result.output).not.toContain("saved to");
    expect(await fsp.readFile(path.join(directory, "job.log"), "utf8")).toBe(
      "saved-prefix",
    );
    expect(() => fs.fstatSync(fd())).toThrow(/bad file descriptor|EBADF/i);
  });
  it("does not follow a planted log symlink or overwrite its target", async () => {
    const target = path.join(directory, "untouched");
    await fsp.writeFile(target, "original");
    await fsp.symlink(target, path.join(directory, "job.log"));
    await start();
    child.stdout.emit("data", "a".repeat(40_000));
    close();
    expect(registry.get("job", "session").metadata.outputFile).toEqual({
      status: "unavailable",
    });
    expect(await fsp.readFile(target, "utf8")).toBe("original");
  });
});
