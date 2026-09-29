import { describe, expect, it, vi } from "vitest";
import { FetchDaemonEventStream } from "./events.js";

describe("daemon event stream lifecycle", () => {
  it("cancels a silent response reader on close and does not announce reconnect", async () => {
    const cancel = vi.fn();
    const states: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"hello"}\n\n'),
        );
      },
      cancel,
    });
    const stream = new FetchDaemonEventStream({
      baseUrl: "http://fixture",
      clientId: "client",
      token: "token",
      fetch: (): Promise<Response> => Promise.resolve(new Response(body)),
    });
    await stream.start({
      onConnectionState: (state) => {
        states.push(state);
      },
    });
    await stream.close();
    expect(cancel).toHaveBeenCalledOnce();
    expect(states).toEqual(["connecting", "live"]);
    expect(body.locked).toBe(false);
  }, 1000);
});
