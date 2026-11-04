import { describe, expect, it } from "vitest";
import { TerminalManager } from "./terminal-manager.js";
import type { TerminalSession } from "./terminal-session.js";
import type { TerminalPty } from "./pty.js";
import type { TerminalServerMessage } from "ohbaby-sdk";

class FakePty implements TerminalPty {
  pid = 999999;
  data = new Set<(data: string) => void>();
  exits = new Set<(event: { exitCode: number }) => void>();
  children: { pid: number; name: string }[] = [];
  paused = false;
  written = "";
  cols = 80;
  rows = 24;
  failClose = false;
  closed = false;
  write(data: string): void {
    this.written += data;
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.data.add(listener);
    return {
      dispose: (): void => {
        this.data.delete(listener);
      },
    };
  }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exits.add(listener);
    return {
      dispose: (): void => {
        this.exits.delete(listener);
      },
    };
  }
  inspectChildren(): Promise<readonly { pid: number; name: string }[]> {
    return Promise.resolve(this.children);
  }
  terminate(): Promise<void> {
    if (this.failClose) return Promise.reject(new Error("cleanup failed"));
    this.closed = true;
    this.exit();
    return Promise.resolve();
  }
  emit(data: string): void {
    for (const listener of this.data) listener(data);
  }
  exit(): void {
    for (const listener of this.exits) listener({ exitCode: 0 });
  }
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(): { manager: TerminalManager; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const manager = new TerminalManager({
    createPty: (): Promise<{ pty: TerminalPty; shell: string }> => {
      const pty = new FakePty();
      ptys.push(pty);
      return Promise.resolve({ pty, shell: "sh" });
    },
  });
  return { manager, ptys };
}
const options = { directory: "/tmp", cols: 80, rows: 24 };
function viewer(): {
  open: boolean;
  bufferedAmount: number;
  messages: TerminalServerMessage[];
  code?: number;
  send(message: TerminalServerMessage): void;
  close(code: number): void;
} {
  return {
    open: true,
    bufferedAmount: 0,
    messages: [],
    send(message): void {
      this.messages.push(message);
    },
    close(code): void {
      this.code = code;
      this.open = false;
    },
  };
}

describe("terminal manager", () => {
  it("reserves pending creates before the seventeenth allocation and releases failed slots", async () => {
    const gate = deferred<undefined>();
    const manager = new TerminalManager({
      createPty: async (): Promise<{ pty: TerminalPty; shell: string }> => {
        await gate.promise;
        throw new Error("unavailable");
      },
    });
    const results = Array.from({ length: 16 }, () =>
      manager.create(options).catch((error: unknown) => error),
    );
    await expect(manager.create(options)).rejects.toMatchObject({
      code: "TERMINAL_LIMIT_REACHED",
    });
    gate.resolve(undefined);
    await Promise.all(results);
    await expect(manager.create(options)).rejects.toMatchObject({
      code: "TERMINAL_UNAVAILABLE",
    });
    await manager.stop();
  });
  it("keeps failed cleanup discoverable and retries it before freeing the slot", async () => {
    const { manager, ptys } = setup();
    const info = await manager.create(options);
    const pty = ptys[0];
    pty.children = [{ pid: 1234, name: "node" }];
    await expect(manager.close(info.id)).rejects.toMatchObject({
      code: "TERMINAL_BUSY",
      process: "node",
    });
    expect(manager.list()[0]?.state).toBe("running");
    pty.failClose = true;
    await expect(manager.close(info.id, true)).rejects.toMatchObject({
      code: "TERMINAL_CLOSE_FAILED",
    });
    expect(manager.list()[0]).toMatchObject({
      id: info.id,
      state: "close_failed",
    });
    pty.exit();
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.list()).toHaveLength(1);
    pty.failClose = false;
    await manager.close(info.id);
    expect(pty.closed).toBe(true);
    expect(manager.list()).toEqual([]);
    await manager.stop();
  });
  it("restores parsed output before live output and preserves the process across detach", async () => {
    const { manager, ptys } = setup();
    const info = await manager.create(options);
    const session = requireSession(manager, info.id);
    const pty = ptys[0];
    pty.emit("before\r\n");
    const first = viewer();
    await session.attach(first);
    expect(first.messages[0]).toMatchObject({
      type: "snapshot",
      cols: 80,
      rows: 24,
    });
    expect(first.messages[0]).toHaveProperty(
      "data",
      expect.stringContaining("before"),
    );
    session.detach(first);
    pty.emit("away\r\n");
    await session.resize(100, 30);
    const second = viewer();
    const attaching = session.attach(second);
    pty.emit("after\r\n");
    await attaching;
    await new Promise((r) => setTimeout(r, 20));
    expect(second.messages[0]).toMatchObject({
      type: "snapshot",
      cols: 100,
      rows: 30,
    });
    expect(second.messages[0]).toHaveProperty(
      "data",
      expect.stringContaining("away"),
    );
    expect(second.messages[0]).toHaveProperty(
      "data",
      expect.not.stringContaining("after"),
    );
    expect(second.messages.slice(1)).toEqual([
      { type: "output", data: "after\r\n" },
    ]);
    session.input("hello");
    expect(pty.written).toBe("hello");
    await manager.close(info.id, true);
    expect(second.messages.filter((m) => m.type === "exit")).toHaveLength(1);
    expect(second.code).toBe(1000);
  });
  it("stops pending creations, rejects new work, and clears every process", async () => {
    const gate = deferred<undefined>();
    const pty = new FakePty();
    const manager = new TerminalManager({
      createPty: async (): Promise<{ pty: TerminalPty; shell: string }> => {
        await gate.promise;
        return Promise.resolve({ pty, shell: "sh" });
      },
    });
    const creating = manager.create(options).catch((error: unknown) => error);
    const stopping = manager.stop();
    await expect(manager.create(options)).rejects.toMatchObject({
      code: "TERMINAL_STOPPING",
    });
    gate.resolve(undefined);
    await creating;
    await stopping;
    expect(pty.closed).toBe(true);
    expect(manager.list()).toEqual([]);
  });
});

it("isolates a slow viewer and applies backpressure to an overloaded screen", async () => {
  const { manager, ptys } = setup();
  const info = await manager.create(options);
  const session = requireSession(manager, info.id);
  const pty = ptys[0];
  const slow = viewer();
  const fast = viewer();
  await session.attach(slow);
  await session.attach(fast);
  slow.bufferedAmount = 2 * 1024 * 1024;
  pty.emit("x".repeat(600 * 1024));
  expect(pty.paused).toBe(true);
  await expect.poll(() => pty.paused).toBe(false);
  expect(slow.code).toBe(4408);
  expect(fast.open).toBe(true);
  expect(fast.messages.some((message) => message.type === "output")).toBe(true);
  await manager.close(info.id, true);
});

it("forced shutdown cleans up even if a simultaneous ordinary close finds a busy terminal", async () => {
  const gate = deferred<readonly { pid: number; name: string }[]>();
  const { manager, ptys } = setup();
  const info = await manager.create(options);
  const pty = ptys[0];
  pty.inspectChildren = (): Promise<readonly { pid: number; name: string }[]> =>
    gate.promise;
  const close = manager.close(info.id).catch((error: unknown) => error);
  const stopping = manager.stop();
  gate.resolve([{ pid: 1234, name: "node" }]);
  expect(await close).toMatchObject({ code: "TERMINAL_BUSY" });
  await stopping;
  expect(pty.closed).toBe(true);
  expect(manager.list()).toEqual([]);
});

it("invalid resize does not corrupt the last valid snapshot and natural exit frees a slot", async () => {
  const { manager, ptys } = setup();
  const info = await manager.create(options);
  const session = requireSession(manager, info.id);
  await session.resize(3.5, 0);
  const client = viewer();
  await session.attach(client);
  expect(client.messages[0]).toMatchObject({ cols: 80, rows: 24 });
  ptys[0].emit("last line\r\n");
  ptys[0].exit();
  await expect.poll(() => manager.list().length).toBe(0);
  expect(client.messages.slice(-2)).toEqual([
    { type: "output", data: "last line\r\n" },
    { type: "exit", exitCode: 0 },
  ]);
  await manager.stop();
});

it("restores alternate and normal screens from an actual serialized snapshot", async () => {
  const headless = await import("@xterm/headless");
  const { manager, ptys } = setup();
  const info = await manager.create(options);
  ptys[0].emit("normal screen\r\n\x1b[?1049h\x1b[2J\x1b[Halternate screen");
  const client = viewer();
  await requireSession(manager, info.id).attach(client);
  const snapshot = client.messages[0];
  expect(snapshot.type).toBe("snapshot");
  if (snapshot.type !== "snapshot") throw new Error("No snapshot");
  const restored = new headless.Terminal({
    cols: snapshot.cols,
    rows: snapshot.rows,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((r) => {
      restored.write(snapshot.data, r);
    });
    expect(restored.buffer.active.type).toBe("alternate");
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "alternate screen",
    );
    await new Promise<void>((r) => {
      restored.write("\x1b[?1049l", r);
    });
    expect(restored.buffer.active.type).toBe("normal");
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "normal screen",
    );
  } finally {
    restored.dispose();
    await manager.stop();
  }
});

function requireSession(manager: TerminalManager, id: string): TerminalSession {
  const session = manager.get(id);
  if (!session) throw new Error("Missing terminal");
  return session;
}

it("retains a cleanup failure after shell exit until the owned resources are released", async () => {
  const { manager, ptys } = setup();
  const info = await manager.create(options);
  ptys[0].failClose = true;
  ptys[0].exit();
  await expect.poll(() => manager.list()[0]?.state).toBe("close_failed");
  ptys[0].failClose = false;
  await manager.close(info.id);
  expect(manager.list()).toEqual([]);
});

it("allows a complete large snapshot without weakening the live-output backlog limit", async () => {
  const { manager, ptys } = setup();
  const info = await manager.create({ ...options, cols: 500, rows: 200 });
  const session = requireSession(manager, info.id);
  // Alternate colors prevent serialization from collapsing identical styles.
  const line = "\x1b[31mx\x1b[32my".repeat(250) + "\r\n";
  ptys[0].emit(line.repeat(1000));
  const client = viewer();
  await session.attach(client);
  expect(client.open).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(client.messages[0]))).toBeGreaterThan(
    2 * 1024 * 1024,
  );
  ptys[0].emit("tail");
  await expect.poll(() => client.messages.length).toBe(2);
  expect(client.messages[1]).toEqual({ type: "output", data: "tail" });
  await manager.stop();
});
