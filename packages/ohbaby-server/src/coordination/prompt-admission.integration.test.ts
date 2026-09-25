import { describe, expect, it, vi } from "vitest";
import type {
  UiBackendClient,
  UiPermissionBinding,
  UiPromptReceipt,
  UiSessionIndexEntry,
} from "ohbaby-sdk";
import type { UiPromptQueueExecutionPort } from "ohbaby-agent";
import { createDaemonServerApp } from "../app/create-app.js";

const headers = {
  authorization: "Bearer admission-token",
  "content-type": "application/json",
  "x-ohbaby-client-id": "client",
};
const timestamp = "2026-09-25T00:00:00Z";
const metadata = (id: string): UiSessionIndexEntry => ({
  id,
  title: id,
  createdAt: timestamp,
  updatedAt: timestamp,
});

async function fixture(
  transport: "REST" | "RPC",
  fresh = true,
): Promise<{
  backend: UiBackendClient;
  sessions: UiSessionIndexEntry[];
  hellos: UiPermissionBinding[];
  submit: (id: string, sessionId?: string) => Promise<Response>;
  query: (binding: UiPermissionBinding) => Promise<Response>;
  select: (sessionId: string) => Promise<Response>;
  dispose: () => Promise<void>;
}> {
  const sessions = [metadata("root"), metadata("other")];
  const backend = {
    getSessionIndex: () => Promise.resolve(sessions),
    getPermissionSnapshot: (binding: UiPermissionBinding) =>
      Promise.resolve({
        ...binding,
        permissionEpoch: "epoch",
        permissionRevision: 0,
        requests: [],
      }),
    subscribeEvents: (): (() => void) => (): void => undefined,
    subscribePermissionEvents: (): (() => void) => (): void => undefined,
    submitPromptAccepted: () => Promise.reject(new Error("admission rejected")),
    waitForPrompt: () => new Promise(() => undefined),
  } as unknown as UiBackendClient & UiPromptQueueExecutionPort;
  const app = createDaemonServerApp({
    backend,
    authToken: "admission-token",
    createSessionId: () => "fresh",
  });
  await app.start();
  await app.app.request("/v1/clients", {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientId: "client",
      startupIntent: fresh
        ? { startupSessionMode: { type: "fresh" } }
        : { resumeSessionId: "root" },
    }),
  });
  const response = await app.app.request("/v1/events", { headers });
  if (!response.body) throw new Error("Missing SSE response");
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const hellos: UiPermissionBinding[] = [];
  const pump = (async (): Promise<void> => {
    let buffer = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      buffer += new TextDecoder().decode(result.value);
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) {
          const event = JSON.parse(data.slice(6)) as UiPermissionBinding & {
            type: string;
          };
          if (event.type === "hello") hellos.push(event);
        }
      }
    }
  })();
  await vi.waitUntil(() => hellos.length === 1);
  return {
    backend,
    sessions,
    hellos,
    submit: (id, sessionId) =>
      Promise.resolve(
        app.app.request(transport === "REST" ? "/v1/prompts" : "/api/rpc", {
          method: "POST",
          headers,
          body: JSON.stringify(
            transport === "REST"
              ? { text: "test", clientRequestId: id, sessionId }
              : {
                  id,
                  clientId: "client",
                  method: "submitPromptAccepted",
                  params: ["test", { clientRequestId: id, sessionId }],
                },
          ),
        }),
      ),
    query: (binding) =>
      Promise.resolve(
        app.app.request(
          `/v1/permissions?${new URLSearchParams({ permissionEpoch: binding.permissionEpoch, rootSessionId: binding.rootSessionId ?? "", bindingGeneration: String(binding.bindingGeneration) }).toString()}`,
          { headers },
        ),
      ),
    select: (sessionId) =>
      Promise.resolve(
        app.app.request(`/v1/sessions/${sessionId}/select`, {
          method: "PATCH",
          headers,
        }),
      ),
    dispose: async (): Promise<void> => {
      await reader.cancel();
      await pump;
      await app.dispose();
    },
  };
}

describe.each(["REST", "RPC"] as const)(
  "%s prompt admission bindings",
  (transport) => {
    it.each([true, false])(
      "publishes a queryable binding after rejected admission (fresh=%s)",
      async (fresh) => {
        const test = await fixture(transport, fresh);
        try {
          await test.submit("rejected", fresh ? undefined : "other");
          await vi.waitUntil(() => test.hellos.length === 2);
          const latest = test.hellos[1];
          expect(latest).toMatchObject({
            rootSessionId: fresh ? null : "other",
            bindingGeneration: fresh ? 3 : 2,
          });
          expect((await test.query(latest)).status).toBe(200);
        } finally {
          await test.dispose();
        }
      },
    );

    it("waits for concurrent admission success before confirming a provisional root", async () => {
      const test = await fixture(transport);
      const pending: {
        resolve: (receipt: UiPromptReceipt) => void;
        reject: (error: Error) => void;
      }[] = [];
      test.backend.submitPromptAccepted = (): Promise<UiPromptReceipt> =>
        new Promise<UiPromptReceipt>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      try {
        const first = test.submit("first");
        await vi.waitUntil(() => pending.length === 1);
        const second = test.submit("second");
        await vi.waitUntil(() => pending.length === 2);
        pending[0].reject(new Error("first rejected"));
        await first;
        expect(test.hellos).toHaveLength(1);
        test.sessions.push(metadata("fresh"));
        pending[1].resolve({
          promptId: "prompt",
          clientRequestId: "second",
          userMessageId: "message",
          sessionId: "fresh",
          status: "queued",
          createdAt: timestamp,
        });
        await second;
        await vi.waitUntil(() => test.hellos.length === 2);
        expect(test.hellos[1]).toMatchObject({
          rootSessionId: "fresh",
          bindingGeneration: 3,
        });
        expect((await test.query(test.hellos[1])).status).toBe(200);
      } finally {
        await test.dispose();
      }
    });

    it("keeps an accepted binding if waitForPrompt throws synchronously", async () => {
      const test = await fixture(transport);
      test.sessions.push(metadata("fresh"));
      test.backend.submitPromptAccepted = (): Promise<UiPromptReceipt> =>
        Promise.resolve({
          promptId: "prompt",
          clientRequestId: "accepted",
          userMessageId: "message",
          sessionId: "fresh",
          status: "queued",
          createdAt: timestamp,
        });
      test.backend.waitForPrompt = (): never => {
        throw new Error("wait unavailable");
      };
      try {
        await test.submit("accepted");
        await vi.waitUntil(() => test.hellos.length === 2);
        expect(test.hellos[1]).toMatchObject({
          rootSessionId: "fresh",
          bindingGeneration: 3,
        });
        expect((await test.query(test.hellos[1])).status).toBe(200);
      } finally {
        await test.dispose();
      }
    });
  },
);
