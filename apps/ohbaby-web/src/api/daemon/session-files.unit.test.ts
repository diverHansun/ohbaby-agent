import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonHttpClient, isDaemonRequestError } from "./http.js";
import { sessionFileContent } from "./session-files.js";

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
