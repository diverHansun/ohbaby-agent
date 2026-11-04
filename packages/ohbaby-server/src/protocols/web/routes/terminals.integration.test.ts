import { once } from "node:events";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { TerminalServerMessage } from "ohbaby-sdk";
import { TerminalWebSocketViewer } from "./terminals.js";

it("delivers a large snapshot, subsequent output, and exit in order over a real socket", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null)
    throw new Error("Missing listener");
  const data = "x".repeat(3 * 1024 * 1024);
  server.on("connection", (socket) => {
    const viewer = new TerminalWebSocketViewer(socket);
    viewer.send({ type: "snapshot", data, cols: 500, rows: 200 });
    viewer.send({ type: "output", data: "after-snapshot" });
    viewer.send({ type: "exit", exitCode: 0 });
    viewer.close(1000);
  });
  const client = new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
  const messages: TerminalServerMessage[] = [];
  client.on("message", (message) => {
    if (Buffer.isBuffer(message))
      messages.push(JSON.parse(message.toString()) as TerminalServerMessage);
  });
  try {
    expect((await once(client, "close"))[0]).toBe(1000);
    expect(messages).toEqual([
      { type: "snapshot", data, cols: 500, rows: 200 },
      { type: "output", data: "after-snapshot" },
      { type: "exit", exitCode: 0 },
    ]);
  } finally {
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
