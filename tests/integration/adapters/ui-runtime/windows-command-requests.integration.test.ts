import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { createTestUiRuntimeComposition } from "../../../fixtures/runtime-model-fixtures.js";
import { AgentManager } from "../../../../packages/ohbaby-agent/src/agents/index.js";
import { createBus } from "../../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../../packages/ohbaby-agent/src/core/message/index.js";
import { createPermissionState } from "../../../../packages/ohbaby-agent/src/permission/index.js";
import { createInMemorySessionManager } from "../../../../packages/ohbaby-agent/src/services/session/index.js";
import { InMemoryShellJobStore } from "../../../../packages/ohbaby-agent/src/shell-jobs/store.js";
import { SkillRegistry } from "../../../../packages/ohbaby-agent/src/skill/index.js";

function tool(
  name: string,
  params: Record<string, unknown>,
  id: string,
): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      { id, index: 0, name, argumentsDelta: JSON.stringify(params) },
    ],
  };
}

describe.runIf(process.platform === "win32")(
  "Windows runtime command requests",
  () => {
    it("runs background Bash and subagent requests, then glob/grep/edit/read in the next turn", async () => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-win-requests-")),
      );
      const bus = createBus();
      const messages = createMessageManager({
        bus,
        store: createInMemoryMessageStore(),
      });
      const sessions = createInMemorySessionManager({
        bus,
        messageCleaner: messages,
      });
      const jobs = new InMemoryShellJobStore();
      const steps = new Map<string, number>();
      let followup = false;
      const requests: {
        scope?: string;
        messages: string;
        followup: boolean;
        lastToolResult: string;
      }[] = [];
      const llm: LLMClientInstance = {
        config: {
          apiKeyEnv: "UNUSED",
          baseUrl: "http://127.0.0.1/unused",
          interfaceProvider: "openai-compatible",
          provider: "fixture",
          model: "fixture",
          maxTokens: 128,
          temperature: 0,
        },
        provider: {
          client: {},
          id: "fixture",
          kind: "openai-compatible",
          isAbortError: () => false,
          streamResponse(request) {
            const scope = request.contextScopeId ?? "parent";
            const key = scope === "parent" && followup ? "followup" : scope;
            const step = steps.get(key) ?? 0;
            steps.set(key, step + 1);
            requests.push({
              scope: request.contextScopeId,
              messages: JSON.stringify(request.messages),
              followup,
              lastToolResult: JSON.stringify(
                request.messages
                  .filter((message) => message.role === "tool")
                  .at(-1) ?? null,
              ),
            });
            const fileCalls = [
              tool("glob", { path: root, pattern: "seed.txt" }, "parent-glob"),
              tool(
                "grep",
                {
                  path: root,
                  pattern: "WINDOWS_READ_SENTINEL",
                  include: "seed.txt",
                },
                "parent-grep",
              ),
              tool(
                "edit",
                {
                  file_path: path.join(root, "seed.txt"),
                  old_string: "WINDOWS_READ_SENTINEL",
                  new_string: "WINDOWS_EDITED_SENTINEL",
                },
                "parent-edit",
              ),
              tool(
                "read",
                { file_path: path.join(root, "seed.txt") },
                "parent-read",
              ),
            ];
            const event =
              scope === "parent"
                ? followup
                  ? (fileCalls[step] ?? {
                      finishReason: "stop" as const,
                      textDelta: "FILES_DONE",
                    })
                  : step === 0
                    ? tool(
                        "bash",
                        {
                          command: `& '${process.execPath.replaceAll("'", "''")}' gate.cjs`,
                          run_in_background: true,
                          timeout: 10000,
                          description: "Windows background fixture",
                        },
                        "parent-background",
                      )
                    : step === 1
                      ? tool(
                          "agent",
                          {
                            action: "spawn",
                            role: "explore",
                            prompt:
                              "Run the Windows child command and read seed.txt",
                            description: "Windows child",
                          },
                          "spawn-child",
                        )
                      : {
                          finishReason: "stop" as const,
                          textDelta: "PARENT_DONE",
                        }
                : step === 0
                  ? tool(
                      "bash",
                      {
                        command: "Write-Output 'CHILD_COMMAND_OK'",
                        auto_background: false,
                      },
                      "child-bash",
                    )
                  : step === 1
                    ? tool(
                        "read",
                        { file_path: path.join(root, "seed.txt") },
                        "child-read",
                      )
                    : {
                        finishReason: "stop" as const,
                        textDelta: "CHILD_DONE",
                      };
            return Promise.resolve(
              (async function* (): AsyncGenerator<
                InterfaceProviderStreamEvent,
                void,
                unknown
              > {
                yield await Promise.resolve(event);
              })(),
            );
          },
        },
      };
      await fs.writeFile(path.join(root, "seed.txt"), "WINDOWS_READ_SENTINEL");
      await fs.writeFile(
        path.join(root, "gate.cjs"),
        "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('release.txt')) { clearInterval(timer); fs.writeFileSync('done.txt', 'BACKGROUND_DONE'); console.log('BACKGROUND_DONE'); } }, 25);",
      );
      const composition = await createTestUiRuntimeComposition({
        agentManager: new AgentManager(),
        bus,
        messageManager: messages,
        sessionManager: sessions,
        llmClient: llm,
        shellJobStore: jobs,
        workdir: root,
        permissionState: createPermissionState({
          bus,
          initialLevel: "full-access",
        }),
        permission: { ask: () => Promise.resolve("reject") },
        mcpManager: { getAllTools: () => Promise.resolve([]) },
        goalExecutionControl: {
          interruptGoalExecution: () => Promise.resolve(),
        },
        skillRegistry: new SkillRegistry({
          loader: {
            scan: (): Promise<Map<string, never>> =>
              Promise.resolve(new Map<string, never>()),
            loadContent: (): Promise<never> =>
              Promise.reject(new Error("No skill fixture")),
          },
        }),
      });
      try {
        const run = await composition.startSession({
          triggerSource: "user",
          agentName: "build",
          projectRoot: root,
          sessionId: "win-parent",
          prompt: "Exercise background command and delegate child",
        });
        const completion = await composition.runManager.waitForCompletion(
          run.runId,
        );
        expect(completion.status).toBe("succeeded");
        expect(completion.error).toBeUndefined();
        expect(
          jobs.listByRootRun(run.runId).find((j) => j.mode === "background")
            ?.status,
        ).toBe("running");
        await fs.writeFile(path.join(root, "release.txt"), "release");
        await expect
          .poll(
            async () =>
              (
                await composition.listSubagentState("win-parent")
              ).executions.map((e) => e.status),
            { timeout: 15000 },
          )
          .toEqual(["completed"]);
        await expect
          .poll(
            () =>
              jobs.listByRootRun(run.runId).find((j) => j.mode === "background")
                ?.cleanup,
            { timeout: 10000 },
          )
          .toBe("confirmed");
        const parentJob = jobs
          .listByRootRun(run.runId)
          .find((j) => j.mode === "background");
        expect(parentJob).toMatchObject({
          status: "completed",
          exitCode: 0,
          cleanup: "confirmed",
        });
        expect(await fs.readFile(path.join(root, "done.txt"), "utf8")).toBe(
          "BACKGROUND_DONE",
        );
        const childRequests = requests.filter((r) => r.scope !== undefined);
        expect(childRequests).toHaveLength(3);
        expect(childRequests[1]?.messages).toContain("CHILD_COMMAND_OK");
        expect(childRequests[2]?.messages).toContain("WINDOWS_READ_SENTINEL");
        expect(childRequests[2]?.messages).not.toContain("source-cleanup");
        const state = await composition.listSubagentState("win-parent");
        expect(state.executions[0]?.output).toContain("CHILD_DONE");
        followup = true;
        const next = await composition.startSession({
          triggerSource: "user",
          agentName: "build",
          projectRoot: root,
          sessionId: "win-parent",
          prompt:
            "Now glob, grep, edit and read seed.txt after the completed commands",
        });
        const nextCompletion = await composition.runManager.waitForCompletion(
          next.runId,
        );
        expect(nextCompletion.status).toBe("succeeded");
        expect(nextCompletion.finalResponse).toBe("FILES_DONE");
        const fileRequests = requests.filter(
          (request) => request.followup && request.scope === undefined,
        );
        expect(fileRequests).toHaveLength(5);
        expect(fileRequests[1]?.lastToolResult).toContain("seed.txt");
        expect(fileRequests[2]?.lastToolResult).toContain(
          "WINDOWS_READ_SENTINEL",
        );
        expect(fileRequests[4]?.lastToolResult).toContain(
          "WINDOWS_EDITED_SENTINEL",
        );
        expect(await fs.readFile(path.join(root, "seed.txt"), "utf8")).toBe(
          "WINDOWS_EDITED_SENTINEL",
        );
      } finally {
        await composition.dispose();
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 30000);
  },
);
