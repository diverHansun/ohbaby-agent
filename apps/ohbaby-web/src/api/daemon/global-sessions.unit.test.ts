import { describe, expect, it } from "vitest";
import { GlobalSessionsClient } from "./global-sessions.js";
import { DaemonHttpClient, isDaemonRequestError } from "./http.js";

const session = {
  id: "s1",
  title: "First",
  status: "active" as const,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  messageCount: 2,
  workspaceDirectory: null,
  workingDirectory: "/home/u/.ohbaby/workspace",
};

function recorder(response: () => Response): {
  readonly fetch: typeof fetch;
  readonly requests: { url: string; init: RequestInit | undefined }[];
} {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  return {
    requests,
    fetch: (input, init): Promise<Response> => {
      requests.push({
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        init,
      });
      return Promise.resolve(response());
    },
  };
}

function http(fetcher: typeof fetch, directory?: string): DaemonHttpClient {
  return new DaemonHttpClient({
    baseUrl: "http://localhost:4096",
    clientId: "client_global",
    token: "secret",
    fetch: fetcher,
    ...(directory === undefined ? {} : { directory }),
  });
}

describe("global session transport", () => {
  it("lists a page without a directory header, even from a scoped client", async () => {
    const fake = recorder(() =>
      Response.json({ ok: true, sessions: [session], nextCursor: "c2" }),
    );
    const client = new GlobalSessionsClient(http(fake.fetch, "/workspace"));
    const page = await client.listSessions({ limit: 100, cursor: "c1" });
    expect(page).toEqual({ sessions: [session], nextCursor: "c2" });
    expect(fake.requests[0]?.url).toBe(
      "http://localhost:4096/v1/sessions?limit=100&cursor=c1",
    );
    const headers = new Headers(fake.requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("x-ohbaby-directory")).toBeNull();
  });

  it("searches with an encoded query", async () => {
    const fake = recorder(() => Response.json({ ok: true, results: [] }));
    await new GlobalSessionsClient(http(fake.fetch)).searchSessions({
      query: "a b&完整",
    });
    expect(fake.requests[0]?.url).toBe(
      "http://localhost:4096/v1/sessions/search?q=a+b%26%E5%AE%8C%E6%95%B4",
    );
  });

  it("moves a session and returns the updated row", async () => {
    const fake = recorder(() => Response.json({ ok: true, session }));
    const moved = await new GlobalSessionsClient(http(fake.fetch)).moveSession(
      "s/1",
      null,
    );
    expect(moved).toEqual(session);
    expect(fake.requests[0]?.url).toBe(
      "http://localhost:4096/v1/sessions/s%2F1/workspace",
    );
    expect(fake.requests[0]?.init?.method).toBe("POST");
    expect(fake.requests[0]?.init?.body).toBe('{"workspaceDirectory":null}');
  });
});

describe("daemon error parsing", () => {
  it("keeps SESSION_MOVED targetDirectory", async () => {
    const fake = recorder(() =>
      Response.json(
        {
          ok: false,
          error: {
            message: "moved",
            code: "SESSION_MOVED",
            targetDirectory: "/next",
          },
        },
        { status: 409 },
      ),
    );
    const error: unknown = await http(fake.fetch, "/old")
      .request("/v1/prompts", { method: "POST", body: {} })
      .catch((caught: unknown) => caught);
    expect(isDaemonRequestError(error)).toBe(true);
    expect(error).toMatchObject({
      message: "moved",
      code: "SESSION_MOVED",
      status: 409,
      targetDirectory: "/next",
    });
  });

  it("omits targetDirectory when the body has none", async () => {
    const fake = recorder(() => new Response("not json", { status: 500 }));
    const error: unknown = await http(fake.fetch)
      .request("/v1/scopes")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 500 });
    expect(error).not.toHaveProperty("targetDirectory");
  });
});
