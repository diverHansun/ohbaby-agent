import { describe, expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "ohbaby-agent";
import { createBus } from "../../../ohbaby-agent/src/bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../../ohbaby-agent/src/core/message/index.js";
import { createDaemonHttpServer } from "../runtime/daemon/server.js";

describe("SSE notification fault boundary", () => {
  it("closes only the failing real HTTP stream after a committed message and continues healthy delivery", async () => {
    const bus = createBus();
    const store = createInMemoryMessageStore();
    const messages = createMessageManager({ bus, store });
    const backend = createInProcessUiBackendClient({
      bus,
      messageManager: messages,
    });
    const session = await backend.createSession();
    const disconnected: string[] = [];
    const server = createDaemonHttpServer({
      backend,
      host: "127.0.0.1",
      port: 0,
      authToken: "notification-token",
      onClientDisconnected: (id) => {
        disconnected.push(id);
      },
    });
    await server.start();
    const headers = {
      authorization: "Bearer notification-token",
      "content-type": "application/json",
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reapplied to the original controller with call
    const original = ReadableStreamDefaultController.prototype.enqueue;
    let failing: ReadableStreamDefaultController<unknown> | undefined;
    let fail = false;
    const enqueue = vi
      .spyOn(ReadableStreamDefaultController.prototype, "enqueue")
      .mockImplementation(function (
        this: ReadableStreamDefaultController<unknown>,
        chunk?: unknown,
      ): void {
        if (chunk instanceof Uint8Array) {
          const text = new TextDecoder().decode(chunk);
          if (
            !failing &&
            text.includes('"clientId":"broken"') &&
            text.includes('"type":"hello"')
          )
            // eslint-disable-next-line @typescript-eslint/no-this-alias -- identify the server writer selected for fault injection
            failing = this;
          if (
            fail &&
            this === failing &&
            text.includes('"type":"session.changed"')
          )
            throw new Error("injected socket writer failure");
        }
        original.call(this, chunk);
      });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (const clientId of ["broken", "healthy"]) {
        const registered = await fetch(`${server.url}/v1/clients`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId,
            startupIntent: { resumeSessionId: session.id },
          }),
        });
        expect(registered.status).toBe(200);
        const response = await fetch(`${server.url}/v1/events`, {
          headers: { ...headers, "x-ohbaby-client-id": clientId },
        });
        const reader = response.body?.getReader() as
          | ReadableStreamDefaultReader<Uint8Array>
          | undefined;
        if (!reader) throw new Error("SSE response missing");
        await reader.read();
        readers.push(reader);
      }
      expect(failing).toBeDefined();
      fail = true;
      const committed = await messages.createMessage({
        id: "committed-after-socket-failure",
        sessionId: session.id,
        role: "assistant",
        agent: "test",
      });
      expect((await store.getMessage(committed.id))?.id).toBe(committed.id);
      expect(disconnected).toEqual(["broken"]);
      const brokenReader = readers.at(0);
      const healthyReader = readers.at(1);
      if (!brokenReader || !healthyReader)
        throw new Error("missing connected readers");
      expect(await brokenReader.read()).toMatchObject({ done: true });
      const received = new TextDecoder().decode(
        (await healthyReader.read()).value,
      );
      expect(received).toContain('"session.changed"');
      expect(received).toContain(committed.id);
      await messages.appendPart(committed.id, {
        type: "text",
        text: "still committed",
      });
      const next = new TextDecoder().decode((await healthyReader.read()).value);
      expect(next).toContain("still committed");
      expect(
        (
          await backend.getSessionView({ sessionId: session.id })
        ).session.messages.some((message) => message.id === committed.id),
      ).toBe(true);
      expect(
        await backend.getSessionControl({ sessionId: session.id }),
      ).toMatchObject({ runId: null });
    } finally {
      enqueue.mockRestore();
      await Promise.all(
        readers.map((reader) => reader.cancel().catch(() => undefined)),
      );
      await server.stop();
      await backend.dispose();
    }
  });
});
