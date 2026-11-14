import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type {
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { McpManager } from "../mcp/index.js";
import { closeDatabase, getDatabase } from "../services/database/index.js";
import { DatabaseShellJobStore } from "../tools/shell-job-store.js";
import { readProcessIdentity } from "../shell/process-identity.js";
import { createPersistentUiBackendClient } from "./ui-persistent.js";

it.skipIf(process.platform === "win32")(
  "uses the configured wait and independent main and child quotas through the persistent runtime",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-runtime-quota-"));
    const home = join(directory, "home");
    const work = join(directory, "work");
    let client: ReturnType<typeof createPersistentUiBackendClient> | undefined;
    let releaseChildren: (() => void) | undefined;
    try {
      await mkdir(join(home, "tools"), { recursive: true });
      await mkdir(work);
      await writeFile(
        join(home, "tools", "shell.json"),
        JSON.stringify({
          defaultForegroundWaitMs: 50,
          maxRunningBackgroundJobs: 2,
          maxRunningSubagentBackgroundJobs: 1,
        }),
      );
      vi.stubEnv("OHBABY_HOME", home);
      vi.spyOn(McpManager.prototype, "getAllTools").mockResolvedValue([]);
      const childHold = new Promise<void>((resolve) => {
        releaseChildren = resolve;
      });
      const childSteps = new Map<string, number>();
      const mainCalls = [
        {
          name: "bash",
          args: { command: "sleep 30" },
        },
        {
          name: "bash",
          args: { command: "sleep 30", run_in_background: true },
        },
        {
          name: "bash",
          args: { command: "sleep 30", run_in_background: true },
        },
        {
          name: "bash",
          args: {
            command: "printf MAIN_FOREGROUND_OK",
            run_in_background: false,
          },
        },
        {
          name: "agent",
          args: {
            action: "spawn",
            role: "generic",
            name: "Quota A",
            prompt: "Check the background quota for child A.",
          },
        },
        {
          name: "agent",
          args: {
            action: "spawn",
            role: "generic",
            name: "Quota B",
            prompt: "Check the background quota for child B.",
          },
        },
      ];
      let serial = 0;
      const llmClient: LLMClientInstance = {
        config: {
          provider: "openai",
          model: "test-model",
          interfaceProvider: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          maxTokens: 256,
          contextWindowTokens: 128000,
        },
        provider: {
          id: "openai",
          kind: "openai-compatible",
          client: {},
          isAbortError: () => false,
          streamResponse(request) {
            let call:
              | { name: string; args: Record<string, unknown> }
              | undefined;
            let hold = false;
            if (request.purpose === "agent-step") {
              expect(
                request.tools?.find((tool) => tool.name === "bash")
                  ?.description,
              ).toContain("after 50ms");
              if (request.contextScopeId) {
                const step = (childSteps.get(request.contextScopeId) ?? 0) + 1;
                childSteps.set(request.contextScopeId, step);
                if (step <= 2)
                  call = {
                    name: "bash",
                    args:
                      step === 1
                        ? { command: "sleep 30" }
                        : { command: "sleep 30", run_in_background: true },
                  };
                else if (step === 3)
                  call = {
                    name: "bash",
                    args: {
                      command: "printf CHILD_FOREGROUND_OK",
                      run_in_background: false,
                    },
                  };
                else hold = true;
              } else call = mainCalls.shift();
            }
            const id = `quota-call-${String(++serial)}`;
            return Promise.resolve(
              (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                if (hold) await childHold;
                yield await Promise.resolve(
                  call
                    ? {
                        finishReason: "tool_calls" as const,
                        toolCallDeltas: [
                          {
                            id,
                            index: 0,
                            name: call.name,
                            argumentsDelta: JSON.stringify(call.args),
                          },
                        ],
                      }
                    : {
                        textDelta: "Quota fixture finished",
                        finishReason: "stop" as const,
                      },
                );
              })(),
            );
          },
        },
      };
      client = createPersistentUiBackendClient({
        dbPath: join(home, "test.db"),
        workdir: work,
        llmClient,
        enableSnapshots: false,
      });
      await client.setPermission({ level: "full-access" });
      const { prompt } = await client.submitPromptAndWait(
        "Exercise configured background limits and start both children.",
      );
      const store = new DatabaseShellJobStore();
      await vi.waitFor(
        () => {
          const jobs = store.query({
            scope: { rootSessionId: prompt.sessionId },
            limit: 100,
          }).rows;
          expect(
            jobs.filter(
              (row) => row.contextScopeId === null && row.status === "running",
            ),
          ).toHaveLength(2);
          expect(
            jobs.filter(
              (row) => row.contextScopeId !== null && row.status === "running",
            ),
          ).toHaveLength(2);
          expect(
            [...childSteps.values()].filter((step) => step >= 4),
          ).toHaveLength(2);
        },
        { timeout: 10000 },
      );
      const all = getDatabase()
        .prepare<{
          job_id: string;
          pid: number | null;
          context_scope_id: string | null;
          mode: string;
          promoted_at: number | null;
          status: string;
          command: string;
        }>(
          "SELECT job_id,pid,context_scope_id,mode,promoted_at,status,command FROM shell_job WHERE root_session_id=?",
        )
        .all(prompt.sessionId);
      expect(all.filter((row) => row.mode === "background")).toHaveLength(4);
      expect(
        all.filter(
          (row) => row.mode === "background" && row.promoted_at !== null,
        ),
      ).toHaveLength(3);
      expect(
        new Set(
          all
            .filter((row) => row.context_scope_id !== null)
            .map((row) => row.context_scope_id),
        ).size,
      ).toBe(2);
      const childBackground = all.filter(
        (row) => row.mode === "background" && row.context_scope_id !== null,
      );
      expect(childBackground).toHaveLength(2);
      expect(
        new Set(childBackground.map((row) => row.context_scope_id)).size,
      ).toBe(2);
      const childJobIds = childBackground.map((row) => row.job_id);
      const mainJobIds = all
        .filter(
          (row) => row.mode === "background" && row.context_scope_id === null,
        )
        .map((row) => row.job_id);
      expect(all.filter((row) => row.mode === "foreground")).toHaveLength(3);
      expect(
        all
          .filter((row) => row.mode === "foreground")
          .every((row) => row.status === "completed"),
      ).toBe(true);
      const parts = getDatabase()
        .prepare<{
          data: string;
          context_scope_id: string | null;
        }>(
          "SELECT part.data, message.context_scope_id FROM part JOIN message ON message.id=part.message_id WHERE message.session_id IN (SELECT id FROM session WHERE id=? OR parent_id=?)",
        )
        .all(prompt.sessionId, prompt.sessionId);
      const text = parts.map((row) => row.data).join("\n");
      expect(text).toContain("moved to the background automatically");
      expect(text).toContain(
        "Background task capacity reached (2/2 tasks for this owner)",
      );
      expect(text).toContain(
        "Background task capacity reached (1/1 tasks for this owner)",
      );
      expect(text).toContain("MAIN_FOREGROUND_OK");
      expect(text).toContain("CHILD_FOREGROUND_OK");
      for (const child of childBackground) {
        const childText = parts
          .filter((part) => part.context_scope_id === child.context_scope_id)
          .map((part) => part.data)
          .join("\n");
        expect(childText).toContain(
          "Background task capacity reached (1/1 tasks for this owner)",
        );
        expect(childText).toContain("CHILD_FOREGROUND_OK");
      }
      releaseChildren?.();
      await vi.waitFor(
        () => {
          const jobs = store.query({
            scope: { rootSessionId: prompt.sessionId },
            limit: 100,
          }).rows;
          for (const jobId of childJobIds) {
            expect(jobs.find((row) => row.jobId === jobId)).toMatchObject({
              status: "cancelled",
              stopReason: "owner-ended",
              cleanup: "confirmed",
            });
          }
          for (const jobId of mainJobIds) {
            expect(jobs.find((row) => row.jobId === jobId)).toMatchObject({
              status: "running",
            });
          }
        },
        { timeout: 10000 },
      );
    } finally {
      releaseChildren?.();
      try {
        if (client) {
          expect(await client.dispose()).toEqual({
            status: "confirmed",
            errors: [],
          });
          for (const job of getDatabase()
            .prepare<{
              pid: number | null;
            }>("SELECT pid FROM shell_job WHERE mode='background'")
            .all()) {
            if (job.pid)
              expect(await readProcessIdentity(job.pid)).toEqual({
                state: "absent",
              });
          }
        }
      } finally {
        try {
          closeDatabase();
        } finally {
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  },
  30000,
);
