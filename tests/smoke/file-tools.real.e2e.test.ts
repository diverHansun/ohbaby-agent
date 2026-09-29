import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  UiPromptCompletion,
  UiPromptReceipt,
  UiSnapshot,
} from "ohbaby-sdk";
import { createDaemonHttpServer } from "../../packages/ohbaby-server/src/runtime/daemon/server.js";
import { createFormalCacheSession } from "./formal-cache-session.js";

const enabled = process.env.OHBABY_RUN_REAL_FILE_TOOLS === "1";
describe.runIf(enabled)(
  "prerequisite B: real model through HTTP file tools",
  () => {
    it("uses long-line continuation, large-file search, edit and write via the persistent runtime", async () => {
      // The provider observer restricts outbound model hosts. Loopback requests
      // belong to this test's own server and do not pass through that observer.
      const localFetch = globalThis.fetch;
      const session = await createFormalCacheSession("zenmux-gpt56-luna-chat", {
        maxRequests: 24,
      });
      const workspace = dirname(session.readFilePath);
      const files = ["long.txt", "search.txt", "edit.txt", "result.txt"];
      await writeFile(
        join(workspace, "long.txt"),
        "字".repeat(18000) + " CONTINUATION_SENTINEL_482\n",
      );
      await writeFile(
        join(workspace, "search.txt"),
        "padding\n".repeat(150000) + "SEARCH_SENTINEL_731\n",
      );
      await writeFile(join(workspace, "edit.txt"), "before-edit\n");
      const token = randomUUID();
      const clientId = randomUUID();
      const server = createDaemonHttpServer({
        backend: session.backend,
        authToken: token,
        host: "127.0.0.1",
        port: 0,
      });
      const permissionErrors: string[] = [];
      const pending = new Set<Promise<void>>();
      const off = session.backend.subscribeEvents((event) => {
        if (event.type !== "permission.requested") return;
        const task = (async () => {
          const snapshot = await session.backend.getSnapshot();
          const run = snapshot.runs.find(
            (item) => item.id === event.request.runId,
          );
          const calls =
            snapshot.sessions
              .find((item) => item.id === run?.sessionId)
              ?.messages.flatMap((message) =>
                message.parts.flatMap((part) =>
                  part.type === "tool-call" &&
                  (part.call.status === "pending" ||
                    part.call.status === "running")
                    ? [part.call]
                    : [],
                ),
              ) ?? [];
          const allowed =
            calls.length > 0 &&
            calls.every(
              (call) =>
                ["read", "grep", "edit", "write"].includes(call.name) &&
                typeof (call.input.file_path ?? call.input.path) === "string" &&
                files.some(
                  (file) =>
                    resolve(
                      workspace,
                      String(call.input.file_path ?? call.input.path),
                    ) === join(workspace, file),
                ),
            );
          const choice = event.request.choices.find((item) =>
            allowed ? item.id === "allow_once" : item.intent === "deny",
          );
          if (!choice) throw new Error("NO_SAFE_PERMISSION_CHOICE");
          await session.backend.respondPermission(event.request.id, {
            choiceId: choice.id,
            remember: false,
          });
        })().catch(async () => {
          permissionErrors.push("PERMISSION_FAILED");
          await session.backend.abortRun(event.request.runId);
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
      let sessionId: string | undefined;
      async function request<T>(route: string, body?: unknown): Promise<T> {
        const response = await localFetch(server.url + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-ohbaby-client-id": clientId,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(240000),
        });
        if (!response.ok) throw new Error(`HTTP_STATUS_${response.status}`);
        return (await response.json()) as T;
      }
      async function submit(text: string): Promise<void> {
        const receipt = await request<UiPromptReceipt>("/v1/prompts", {
          text,
          clientRequestId: randomUUID(),
          ...(sessionId ? { sessionId } : {}),
        });
        sessionId = receipt.sessionId;
        const { completion } = await request<{
          completion: UiPromptCompletion;
        }>(`/v1/prompts/${receipt.promptId}/completion`);
        expect(completion.prompt.status).toBe("succeeded");
        await Promise.all([...pending]);
      }
      try {
        await server.start();
        await request("/v1/clients", { clientId });
        await submit(
          "This is a controlled file-tool verification. Only use read/grep/edit/write, no bash or subagents. Read long.txt with offset=1, limit=1. It is longer than one page; use the returned cursor unchanged in subsequent read calls (limit=1) until the first source line is complete. Report its ending sentinel. Also use grep to find SEARCH_SENTINEL in search.txt. Do not guess file contents.",
        );
        await submit(
          "Now use edit on edit.txt to replace before-edit with after-edit. Use write to create result.txt with exactly FILE_TOOLS_VERIFIED followed by a newline. Read both files to verify. Only use read/edit/write, no shell or subagents.",
        );
        expect(await readFile(join(workspace, "edit.txt"), "utf8")).toBe(
          "after-edit\n",
        );
        expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe(
          "FILE_TOOLS_VERIFIED\n",
        );
        const { snapshot } = await request<{ snapshot: UiSnapshot }>(
          "/v1/snapshot",
        );
        const parts = snapshot.sessions
          .find((item) => item.id === sessionId)!
          .messages.flatMap((message) => message.parts);
        const calls = parts.flatMap((part) =>
          part.type === "tool-call" ? [part.call] : [],
        );
        for (const name of ["read", "grep", "edit", "write"])
          expect(
            calls.some(
              (call) => call.name === name && call.status === "completed",
            ),
          ).toBe(true);
        expect(
          calls.some(
            (call) =>
              call.name === "read" && typeof call.input.cursor === "string",
          ),
        ).toBe(true);
        const texts = parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        expect(texts).toContain("CONTINUATION_SENTINEL_482");
        expect(texts).toContain("SEARCH_SENTINEL_731");
        expect(permissionErrors).toEqual([]);
        const evidenceDir = join(process.cwd(), ".ohbaby/test-evidence/pre-b");
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(
          join(evidenceDir, "real-http.json"),
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              platform: `${process.platform}/${process.arch}`,
              model: "openai/gpt-5.6-luna",
              transport: "HTTP loopback",
              passed: true,
              requests: session.providerRequests.length,
              calls: calls.map((call) => ({
                name: call.name,
                status: call.status,
                cursor: typeof call.input.cursor === "string",
              })),
              filesVerified: true,
              permissionErrors,
            },
            null,
            2,
          ),
        );
      } finally {
        off();
        await server.stop();
        await session.close();
        await rm(session.root, { recursive: true, force: true });
      }
    });
  },
);
