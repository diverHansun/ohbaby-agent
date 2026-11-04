import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TerminalWebSocketViewer } from "./terminals.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closeCode?: number;
  terminated = false;
  holdSends = false;
  readonly callbacks: ((error?: Error) => void)[] = [];
  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    if (this.holdSends) this.callbacks.push(callback);
    else callback();
  }
  close(code: number): void {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSING;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

afterEach(() => vi.useRealTimers());

describe("terminal viewer output bound", () => {
  it("counts encoded JSON plus the underlying socket backlog and isolates the slow viewer", () => {
    vi.useFakeTimers();
    const slow = new Socket();
    const fast = new Socket();
    slow.bufferedAmount = 2 * 1024 * 1024 - 35;
    const slowViewer = new TerminalWebSocketViewer(
      slow as unknown as WebSocket,
    );
    const fastViewer = new TerminalWebSocketViewer(
      fast as unknown as WebSocket,
    );
    const message = { type: "output", data: "\n".repeat(10) } as const;
    slowViewer.send(message);
    fastViewer.send(message);
    expect(slow.closeCode).toBe(4408);
    expect(slow.sent).toEqual([]);
    expect(fast.sent.map((encoded) => JSON.parse(encoded) as unknown)).toEqual([
      message,
    ]);
    expect(fastViewer.open).toBe(true);
    slowViewer.send({ type: "output", data: "ignored" });
    expect(slow.sent).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(slow.terminated).toBe(true);
    expect(fast.terminated).toBe(false);
  });

  it("allows exactly the realtime buffer limit", () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const viewer = new TerminalWebSocketViewer(socket as unknown as WebSocket);
    const message = { type: "output", data: "" } as const;
    socket.bufferedAmount = 2 * 1024 * 1024 - 27;
    viewer.send(message);
    expect(socket.sent).toHaveLength(1);
    socket.bufferedAmount += 1;
    viewer.send(message);
    expect(socket.closeCode).toBe(4408);
    expect(socket.sent).toHaveLength(1);
    socket.terminate();
  });

  it("sends a snapshot larger than 2 MiB before queued realtime output", () => {
    vi.useFakeTimers();
    const socket = new Socket();
    socket.holdSends = true;
    const viewer = new TerminalWebSocketViewer(socket as unknown as WebSocket);
    viewer.send({
      type: "snapshot",
      data: "x".repeat(3 * 1024 * 1024),
      cols: 500,
      rows: 200,
    });
    socket.bufferedAmount = 3 * 1024 * 1024;
    viewer.send({ type: "output", data: "first" });
    viewer.send({ type: "output", data: "second" });
    expect(socket.closeCode).toBeUndefined();
    expect(socket.sent).toHaveLength(1);
    expect(viewer.bufferedAmount).toBe(65);
    socket.bufferedAmount = 0;
    socket.callbacks.shift()?.();
    expect(socket.sent.slice(1)).toEqual([
      '{"type":"output","data":"first"}',
      '{"type":"output","data":"second"}',
    ]);
    expect(viewer.bufferedAmount).toBe(0);
    socket.terminate();
  });

  it("limits realtime backlog while a snapshot is still being sent", () => {
    vi.useFakeTimers();
    const socket = new Socket();
    socket.holdSends = true;
    const viewer = new TerminalWebSocketViewer(socket as unknown as WebSocket);
    viewer.send({ type: "snapshot", data: "large", cols: 80, rows: 24 });
    viewer.send({ type: "output", data: "x".repeat(1024 * 1024) });
    viewer.send({ type: "output", data: "x".repeat(1024 * 1024) });
    expect(socket.closeCode).toBe(4408);
    expect(socket.sent).toHaveLength(1);
    expect(viewer.bufferedAmount).toBe(0);
    socket.callbacks.shift()?.();
    expect(socket.sent).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(socket.terminated).toBe(true);
  });

  it("bounds a stalled snapshot even when no new output arrives", () => {
    vi.useFakeTimers();
    const socket = new Socket();
    socket.holdSends = true;
    const viewer = new TerminalWebSocketViewer(socket as unknown as WebSocket);
    viewer.send({ type: "snapshot", data: "large", cols: 80, rows: 24 });
    vi.advanceTimersByTime(10000);
    expect(socket.closeCode).toBe(4408);
    vi.advanceTimersByTime(1000);
    expect(socket.terminated).toBe(true);
  });

  it("bounds close even when a peer never responds to a normal close frame", () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const viewer = new TerminalWebSocketViewer(socket as unknown as WebSocket);
    viewer.close(1000);
    expect(socket.terminated).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(socket.terminated).toBe(true);
  });
});
