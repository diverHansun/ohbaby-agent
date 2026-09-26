import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  UiPromptCompletion,
  UiPromptReceipt,
  UiSnapshot,
} from "ohbaby-sdk";
import { createDaemonHttpServer } from "../../packages/ohbaby-server/src/runtime/daemon/server.js";
import { createFormalCacheSession } from "./formal-cache-session.js";

const enabled = process.env.OHBABY_RUN_REAL_BASH_CLEANUP === "1";
describe.runIf(enabled)(
  "prerequisite C3: real model through HTTP Bash cleanup",
  () => {
    it("times out a background job, reads it and executes new work after cleanup", async () => {
      // The provider observer restricts outbound model hosts. Loopback requests
      // belong to this test's own server and do not pass through that observer.
      const localFetch = globalThis.fetch;
      const session = await createFormalCacheSession("zenmux-gpt56-luna-chat", {
        maxRequests: 24,
      });
      const allowedCommands = ["sleep 2", "printf C3_RECOVERED"];
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
                (call.name === "bash" &&
                  allowedCommands.includes(String(call.input.command))) ||
                ["task_output", "task_kill", "select_tools"].includes(
                  call.name,
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
          'Controlled Bash cleanup verification. Activate task_output via select_tools if it is not in your available tools. Use bash with command exactly "sleep 2", run_in_background=true, timeout=100. Then read its returned job_id with task_output(block=true, wait_ms=3000). Report the actual job status. Do not run any other shell commands, no subagents, no retries. You must actually call task_output rather than infer the status.',
        );
        await submit(
          'Now verify new work after cleanup: use bash with command exactly "printf C3_RECOVERED", timeout=3000, run_in_background=false. Report its output. Do not use any other tool or command.',
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
        const persistedTools = getDatabase()
          .prepare<{ data: string }>(
            "SELECT data FROM part WHERE session_id = ? AND type = 'tool'",
          )
          .all(sessionId)
          .map(
            (row) =>
              JSON.parse(row.data) as {
                tool: string;
                state: {
                  status: string;
                  metadata?: { status?: string; cleanup?: string };
                  output?: string;
                };
              },
          );
        expect(
          calls.some(
            (call) =>
              call.name === "bash" &&
              call.input.command === "sleep 2" &&
              call.input.run_in_background === true &&
              call.status === "completed",
          ),
        ).toBe(true);
        expect(
          calls.some(
            (call) => call.name === "task_output" && call.status === "failed",
          ),
        ).toBe(true);
        expect(
          calls.some(
            (call) =>
              call.name === "bash" &&
              call.input.command === "printf C3_RECOVERED" &&
              call.status === "completed",
          ),
        ).toBe(true);
        const texts = parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        expect(texts).toContain("C3_RECOVERED");
        // The UI projects the observed job timeout as failed; the control tool
        // itself completed and returned the actual job cleanup facts.
        expect(
          persistedTools.find((part) => part.tool === "task_output")?.state,
        ).toMatchObject({
          status: "completed",
          metadata: { status: "timed_out", cleanup: "confirmed" },
        });
        expect(permissionErrors).toEqual([]);
        const evidenceDir = join(process.cwd(), ".ohbaby/test-evidence/pre-c3");
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
                command: call.input.command,
              })),
              bashCleanupVerified: true,
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
