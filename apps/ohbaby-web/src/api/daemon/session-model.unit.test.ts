import { expect, it } from "vitest";
import { createBrowserDaemonClient } from "./client.js";
import { createOhbabyWebStore } from "../../store/store.js";

it("forwards model writes and scoped reads without reusing the global model response", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = createBrowserDaemonClient({
    config: {
      baseUrl: "http://localhost:4096",
      clientId: "model-client",
      token: "secret",
      directory: "/workspace",
    },
    store: createOhbabyWebStore(),
    fetch: (input, init) => {
      requests.push({
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        init,
      });
      return Promise.resolve(
        Response.json({
          ok: true,
          model: null,
          session: { id: "s", modelEntryId: "a" },
          active: { id: "a" },
          models: [],
        }),
      );
    },
  });
  await client.getCurrentModel();
  await client.getCurrentModel({ sessionId: "chat/a b" });
  await client.updateSessionModel({ sessionId: "chat/a b", modelEntryId: "a" });
  await client.selectDefaultModel("a");
  expect(
    requests.map(
      (request) => new URL(request.url).pathname + new URL(request.url).search,
    ),
  ).toEqual([
    "/v1/model",
    "/v1/model?sessionId=chat%2Fa+b",
    "/v1/sessions/chat%2Fa%20b/model",
    "/v1/settings/models/active",
  ]);
  expect(JSON.parse(requests[2]?.init?.body as string)).toEqual({
    modelEntryId: "a",
  });
  expect(JSON.parse(requests[3]?.init?.body as string)).toEqual({ id: "a" });
  expect(
    new Headers(requests[3]?.init?.headers).has("x-ohbaby-directory"),
  ).toBe(false);
});
