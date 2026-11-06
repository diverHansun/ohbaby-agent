import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonHttpClient, isDaemonRequestError } from "./http.js";
import { sessionFileContent } from "./session-files.js";
import { BrowserDaemonClient } from "./client.js";
import { FetchDaemonEventStream } from "./events.js";
import { createOhbabyWebStore } from "../../store/store.js";
import { recoveryBinding } from "./session-recovery.test-utils.js";

function client(fetchImpl: typeof fetch): DaemonHttpClient {
  return new DaemonHttpClient({
    baseUrl: "http://daemon.test",
    clientId: "client-1",
    directory: "/work",
    fetch: fetchImpl,
    token: "secret",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session file requests", () => {
  it("lists scratch with the binding in the query and the bearer header", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          ok: true,
          files: [
            { path: "a.md", size: 3, modifiedAt: "2026-11-05T00:00:00Z" },
          ],
        }),
      ),
    );
    const result = await client(fetchImpl).listSessionFiles({
      sessionId: "root/1",
      runtimeEpoch: "epoch",
      bindingGeneration: 4,
    });
    expect(result.files).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url as string).toBe(
      "http://daemon.test/v1/sessions/root%2F1/files?runtimeEpoch=epoch&bindingGeneration=4",
    );
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
  });

  it("reads one file unparsed, with its path encoded in the query", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response("# Notes", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      ),
    );
    const response = await client(fetchImpl).readSessionFile({
      sessionId: "root",
      path: "reports/a b&c.md",
      runtimeEpoch: "epoch",
      bindingGeneration: 1,
    });
    expect(await response.text()).toBe("# Notes");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(new URL(url as string).searchParams.get("path")).toBe(
      "reports/a b&c.md",
    );
    expect((init?.headers as Record<string, string>).accept).toBe("*/*");
  });

  it("turns a coded error body into a request error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          {
            ok: false,
            error: { code: "UNSUPPORTED_FILE_TYPE", message: "Binary file" },
          },
          { status: 415 },
        ),
      ),
    );
    const error: unknown = await client(fetchImpl)
      .readSessionFile({ sessionId: "root", path: "a.zip" })
      .catch((caught: unknown) => caught);
    expect(isDaemonRequestError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
      status: 415,
      message: "Binary file",
    });
  });
});

describe("sessionFileContent", () => {
  it("keeps text as text, including HTML the server sends as plain text", async () => {
    const content = await sessionFileContent(
      new Response("<b>hi</b>", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    expect(content).toEqual({ kind: "text", text: "<b>hi</b>" });
  });

  it("turns image bytes into an object URL", async () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:image");
    const content = await sessionFileContent(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    );
    expect(content).toEqual({ kind: "image", url: "blob:image" });
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("browser file read binding", () => {
  it.each([
    { type: "text/plain", changed: true },
    { type: "image/png", changed: true },
    { type: "text/plain", changed: false },
    { type: "image/png", changed: false },
  ])(
    "$type body completion with changed binding: $changed",
    async ({ type, changed }) => {
      const config = {
        baseUrl: "http://daemon.test",
        clientId: "client-1",
        token: "secret",
      };
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            body = controller;
          },
        }),
        { headers: { "content-type": type } },
      );
      let bodyStarted!: () => void;
      const readingBody = new Promise<void>((resolve) => {
        bodyStarted = resolve;
      });
      const method = type.startsWith("image/") ? "blob" : "text";
      const consume = response[method].bind(response);
      vi.spyOn(response, method).mockImplementation(() => {
        bodyStarted();
        return consume();
      });
      const create = vi
        .spyOn(URL, "createObjectURL")
        .mockReturnValue("blob:read");
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      const fetchImpl: typeof fetch = (input) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input
              : input.url,
        );
        if (url.pathname.endsWith("/files/content")) {
          expect(url.searchParams.get("bindingGeneration")).toBe("1");
          return Promise.resolve(response);
        }
        if (url.pathname === "/v1/clients")
          return Promise.resolve(Response.json({ ok: true }));
        if (url.pathname === "/v1/sessions/index")
          return Promise.resolve(Response.json({ ok: true, sessions: [] }));
        return Promise.resolve(
          Response.json(
            { error: { message: "Not needed for this read" } },
            { status: 503 },
          ),
        );
      };
      const events = new FetchDaemonEventStream({
        ...config,
        fetch: fetchImpl,
      });
      let emitBinding!: (generation: number) => void;
      vi.spyOn(events, "start").mockImplementation((callbacks) => {
        callbacks.onConnectionState?.("live");
        emitBinding = (generation): void => {
          void callbacks.onEvent?.({
            payload: {
              type: "hello",
              clientId: config.clientId,
              ...recoveryBinding("root", generation),
            },
          });
        };
        emitBinding(1);
        return Promise.resolve();
      });
      const browser = new BrowserDaemonClient({
        config,
        events,
        http: new DaemonHttpClient({ ...config, fetch: fetchImpl }),
        store: createOhbabyWebStore(),
      });
      try {
        await browser.connect();
        const reading = browser.readSessionFile("root", "file");
        await readingBody;
        if (changed) emitBinding(2);
        body.enqueue(new TextEncoder().encode("file contents"));
        body.close();
        if (changed) {
          await expect(reading).rejects.toThrow(
            "Session binding changed during file read",
          );
          if (type === "image/png")
            expect(revoke).toHaveBeenCalledWith("blob:read");
        } else {
          await expect(reading).resolves.toEqual(
            type === "image/png"
              ? { kind: "image", url: "blob:read" }
              : { kind: "text", text: "file contents" },
          );
          expect(revoke).not.toHaveBeenCalled();
        }
        expect(create).toHaveBeenCalledTimes(type === "image/png" ? 1 : 0);
      } finally {
        await browser.close();
      }
    },
  );
});
