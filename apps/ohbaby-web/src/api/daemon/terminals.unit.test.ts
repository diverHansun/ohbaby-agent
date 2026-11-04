import { TERMINAL_MAX_INPUT_BYTES } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  chunkTerminalInput,
  encodeTokenProtocol,
  TerminalClient,
  terminalSocketUrl,
} from "./terminals.js";

const frameBytes = (data: string): number =>
  new TextEncoder().encode(JSON.stringify({ type: "input", data })).length;

describe("terminal input chunks", () => {
  it("passes typed keys through as one frame", () => {
    expect(chunkTerminalInput("ls -la\r")).toEqual(["ls -la\r"]);
  });

  it("keeps every frame within the limit and the text intact (S15)", () => {
    const paste = `中文 emoji 😀\t"quoted" \\back\n`.repeat(4000);
    const chunks = chunkTerminalInput(paste);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(paste);
    for (const chunk of chunks)
      expect(frameBytes(chunk)).toBeLessThanOrEqual(TERMINAL_MAX_INPUT_BYTES);
    // No surrogate pair is split across frames.
    for (const chunk of chunks)
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk)).toBe(false);
  });

  it("counts JSON escapes, not just characters", () => {
    const chunks = chunkTerminalInput("\u0001".repeat(20_000));
    for (const chunk of chunks)
      expect(frameBytes(chunk)).toBeLessThanOrEqual(TERMINAL_MAX_INPUT_BYTES);
  });
});

describe("terminal socket", () => {
  it("encodes the token as base64url of its UTF-8 bytes", () => {
    const encoded = encodeTokenProtocol("ohbaby_tök+/=");
    expect(encoded).toMatch(/^ohbaby\.bearer\.[A-Za-z0-9_-]+$/u);
    expect(
      Buffer.from(encoded.slice("ohbaby.bearer.".length), "base64url").toString(
        "utf8",
      ),
    ).toBe("ohbaby_tök+/=");
  });

  it("builds the attach URL without the token", () => {
    expect(terminalSocketUrl("", "a b", "http://127.0.0.1:4519")).toBe(
      "ws://127.0.0.1:4519/v1/terminals/a%20b/attach",
    );
    expect(terminalSocketUrl("https://host:9", "id")).toBe(
      "wss://host:9/v1/terminals/id/attach",
    );
  });
});

describe("TerminalClient", () => {
  it("sends the workspace header only on create, and none without a workspace", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true, terminal: { id: "t1" } }), {
            status: 201,
          }),
        ),
    );
    const client = new TerminalClient(
      {
        baseUrl: "http://127.0.0.1:1",
        clientId: "c",
        directory: "/ignored",
        token: "tok",
      },
      fetchImpl,
    );
    await client.create({ directory: "/work", cols: 80, rows: 24 });
    await client.create({ directory: null, cols: 80, rows: 24 });
    await client.list().catch(() => undefined);
    await client.close("t1", false);
    const headers = fetchImpl.mock.calls.map(
      ([, init]) => (init?.headers ?? {}) as Record<string, string>,
    );
    expect(decodeURIComponent(headers[0]?.["x-ohbaby-directory"] ?? "")).toBe(
      "/work",
    );
    // The bootstrap directory never leaks into list, close or a home create.
    for (const header of headers.slice(1))
      expect(header["x-ohbaby-directory"]).toBeUndefined();
  });

  it("keeps the busy program name from a 409", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "TERMINAL_BUSY",
              message: "Terminal has running programs",
              process: "node",
            },
          }),
          { status: 409 },
        ),
      ),
    );
    const client = new TerminalClient(
      { baseUrl: "http://127.0.0.1:1", clientId: "c", token: "tok" },
      fetchImpl,
    );
    await expect(client.close("t1", false)).rejects.toMatchObject({
      code: "TERMINAL_BUSY",
      process: "node",
      status: 409,
    });
    expect(String(fetchImpl.mock.calls[0])).toContain("/v1/terminals/t1");
  });
});
