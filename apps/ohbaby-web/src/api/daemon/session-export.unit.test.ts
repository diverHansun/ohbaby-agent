import { describe, expect, it } from "vitest";
import { DaemonHttpClient } from "./http.js";
import { createBrowserDaemonClient } from "./client.js";
import { createOhbabyWebStore } from "../../store/store.js";

const config = {
  baseUrl: "http://localhost:4096",
  clientId: "client_export",
  token: "secret",
  directory: "/workspace",
};
const artifact = {
  filename: "session.jsonl",
  mimeType: "application/x-ndjson",
  content: '{"text":"完整"}\n',
  messageCount: 1,
};

describe("web session export transport", () => {
  it.each(["http", "browser"])(
    "%s encodes the session path and uses authenticated GET",
    async (kind) => {
      const requests: { url: string; init: RequestInit | undefined }[] = [];
      const fetcher: typeof fetch = (input, init) => {
        requests.push({
          url:
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url,
          init,
        });
        return Promise.resolve(Response.json({ ok: true, export: artifact }));
      };
      const http = new DaemonHttpClient({ ...config, fetch: fetcher });
      const browser = createBrowserDaemonClient({
        config,
        fetch: fetcher,
        store: createOhbabyWebStore(),
      });
      const input = { sessionId: "archive/a b?完整", format: "jsonl" as const };
      const result =
        kind === "http"
          ? (await http.exportSession(input)).export
          : await browser.exportSession(input);
      expect(result).toEqual(artifact);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "http://localhost:4096/v1/sessions/archive%2Fa%20b%3F%E5%AE%8C%E6%95%B4/export?format=jsonl",
      );
      expect(requests[0]?.init?.method).toBe("GET");
      const headers = new Headers(requests[0]?.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret");
      expect(headers.get("x-ohbaby-client-id")).toBe("client_export");
      expect(requests[0]?.init?.body).toBeUndefined();
    },
  );

  it.each([
    {
      error: { message: "missing", code: "SESSION_NOT_FOUND" },
      status: 404,
      code: "SESSION_NOT_FOUND",
    },
    { error: { message: "legacy message" }, status: 500, code: undefined },
  ])(
    "preserves structured and legacy daemon errors $status",
    async ({ error, status, code }) => {
      const client = createBrowserDaemonClient({
        config,
        store: createOhbabyWebStore(),
        fetch: () =>
          Promise.resolve(Response.json({ ok: false, error }, { status })),
      });
      await expect(
        client.exportSession({ sessionId: "archive", format: "html" }),
      ).rejects.toMatchObject({ message: error.message, code, status });
    },
  );

  it.each([404, 500])(
    "preserves HTTP status for non-JSON daemon error %s",
    async (status) => {
      const client = createBrowserDaemonClient({
        config,
        store: createOhbabyWebStore(),
        fetch: () => Promise.resolve(new Response("Not Found", { status })),
      });
      await expect(
        client.exportSession({ sessionId: "archive", format: "html" }),
      ).rejects.toMatchObject({
        message: `Daemon request failed with HTTP ${String(status)}`,
        code: undefined,
        status,
      });
    },
  );

  it("still rejects malformed JSON on successful responses", async () => {
    const client = createBrowserDaemonClient({
      config,
      store: createOhbabyWebStore(),
      fetch: () => Promise.resolve(new Response("Not JSON", { status: 200 })),
    });
    await expect(
      client.exportSession({ sessionId: "archive", format: "html" }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});
