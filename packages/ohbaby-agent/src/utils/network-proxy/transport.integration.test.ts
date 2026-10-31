import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, request, type Dispatcher } from "undici";
import { FetchRouter, TransportGeneration } from "./transport.js";

// undici's own test hooks drive the clock behind its body timeout.
const undiciTimers = createRequire(import.meta.url)(
  "undici/lib/util/timers.js",
) as { tick(delay?: number): void; reset(): void };

const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  undiciTimers.reset();
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  undiciTimers.reset();
});

/** Streams one chunk, stays silent for six minutes, then finishes. */
async function readSilentStream(dispatcher: Dispatcher): Promise<string> {
  let held: http.ServerResponse | undefined;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("first|");
    held = response;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as net.AddressInfo;
  const response = await request(`http://127.0.0.1:${String(port)}/`, {
    dispatcher,
  });
  const chunks: string[] = [];
  const body = (async (): Promise<string> => {
    for await (const chunk of response.body) chunks.push(String(chunk));
    return chunks.join("");
  })();
  void body.catch(() => undefined);
  await vi.waitFor(() => {
    expect(chunks).toEqual(["first|"]);
  });
  // The first tick arms pending timers; the second passes six silent minutes.
  undiciTimers.tick(0);
  undiciTimers.tick(6 * 60_000);
  // Let a body timeout, if any, reach the stream before the server resumes.
  await new Promise((resolve) => setImmediate(resolve));
  held?.end("last");
  return body;
}

/** A minimal CONNECT proxy, so the proxied route is exercised end to end. */
async function connectProxy(): Promise<{
  readonly url: string;
  readonly tunnels: () => number;
}> {
  let tunnels = 0;
  const proxy = http.createServer();
  proxy.on("connect", (request: http.IncomingMessage, client: net.Socket) => {
    tunnels++;
    const [host, port] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        proxy.close(() => {
          resolve();
        });
        proxy.closeAllConnections();
      }),
  );
  return {
    url: `http://127.0.0.1:${String((proxy.address() as net.AddressInfo).port)}`,
    tunnels: () => tunnels,
  };
}

describe("network transport streams", () => {
  it("documents that the library default cuts a stream silent for five minutes", async () => {
    const agent = new Agent();
    cleanups.push(() => agent.close());
    await expect(readSilentStream(agent)).rejects.toMatchObject({
      code: "UND_ERR_BODY_TIMEOUT",
    });
  });

  it.each(["direct", "proxy"] as const)(
    "leaves a silent %s model stream to the runtime idle watchdog",
    async (route) => {
      const proxy = route === "proxy" ? await connectProxy() : undefined;
      const generation = new TransportGeneration({
        status: `Network: ${route}`,
        route: (): string | undefined => proxy?.url,
      });
      cleanups.push(async () => {
        generation.retire();
        await Promise.resolve();
      });
      await expect(
        readSilentStream(new FetchRouter(() => generation)),
      ).resolves.toBe("first|last");
      if (proxy) expect(proxy.tunnels()).toBe(1);
    },
  );
});
