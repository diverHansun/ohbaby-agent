import { execFileSync } from "node:child_process";
import type { ModelRequestRecord } from "../../packages/ohbaby-agent/src/core/llm-client/types.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  UiPromptReceipt,
  UiPromptCompletion,
  UiSteerQueuedPromptReceipt,
} from "ohbaby-sdk";
import {
  collectFormalCleanupErrors,
  getFormalSetupFailureEvidence,
  createFormalCacheSession,
} from "./formal-cache-session.js";
import { createDaemonHttpServer } from "../../packages/ohbaby-server/src/runtime/daemon/server.js";
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { DatabaseSubagentExecutionStore } from "../../packages/ohbaby-agent/src/agents/subagents/execution-store.js";
import type { CurrentRunInputRecord } from "../../packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.js";
import type {
  Message,
  Part,
  ToolPart,
} from "../../packages/ohbaby-agent/src/core/message/types.js";

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
function storedMessages(sessionId?: string): Message[] {
  const query =
    sessionId === undefined
      ? "SELECT data FROM message ORDER BY created_at,id"
      : "SELECT data FROM message WHERE session_id=? ORDER BY created_at,id";
  return getDatabase()
    .prepare<{ data: string }>(query)
    .all(...(sessionId === undefined ? [] : [sessionId]))
    .map((row) => JSON.parse(row.data) as Message);
}
function messageText(messageId: string): string {
  return getDatabase()
    .prepare<{ data: string }>(
      "SELECT data FROM part WHERE message_id=? ORDER BY order_index",
    )
    .all(messageId)
    .map((row) => JSON.parse(row.data) as Part)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}
async function boundedCleanup(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("CLEANUP_TIMEOUT"));
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(
  check: () => Promise<boolean> | boolean,
  label: string,
  timeout = 120000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
it.runIf(process.env.OHBABY_RUN_REAL_SUBAGENT_CONTINUATION === "1")(
  "real HTTP background results and Steer continue the original run before releasing its ordinary queue",
  async () => {
    const isolated = await mkdtemp(join(os.tmpdir(), "improve3-live-"));
    const oldHome = os.homedir;
    const oldStorage = process.env.OHBABY_STORAGE_ROOT;
    os.homedir = (): string => isolated;
    process.env.OHBABY_STORAGE_ROOT = join(isolated, "storage");
    const fetchLocal = globalThis.fetch;
    let session:
      | Awaited<ReturnType<typeof createFormalCacheSession>>
      | undefined;
    let server: ReturnType<typeof createDaemonHttpServer> | undefined;
    let off = (): void => undefined;
    const pending = new Set<Promise<void>>();
    const permissionErrors: string[] = [];
    const startedAt = new Date().toISOString();
    let phase = "setup";
    let assertionsPassed = false;
    let failureCode: string | undefined;
    let sessionDirectory: string | undefined;
    const providerCalls: {
      sequence: number;
      observedAt: string;
      sessionId?: string;
      contextScopeId?: string;
      purpose?: string;
      identity?: ModelRequestRecord;
      userContents: string[];
    }[] = [];
    const evidence: Record<string, unknown> = {
      startedAt,
      replayCommand:
        "OHBABY_RUN_REAL_SUBAGENT_CONTINUATION=1 pnpm exec vitest run --config tests/smoke/subagent-continuation-real.vitest.config.ts",
      model: "openai/gpt-5.6-luna",
      protocol: "openai-responses",
      passed: false,
    };
    try {
      evidence.revision = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      evidence.workingDiffSha256 = digest(
        execFileSync("git", ["diff", "HEAD"], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        }),
      );
      evidence.testSourceSha256 = digest(
        await readFile(new URL(import.meta.url), "utf8"),
      );
      session = await createFormalCacheSession(
        "zenmux-gpt56-luna-responses-context",
        {
          maxRequests: 25,
          requireDetectedWindow: true,
          handleControlledPermissions: false,
          onProviderRequest(request, sequence): void {
            const candidates =
              request.purpose === "agent-step"
                ? storedMessages(request.sessionId)
                    .filter(
                      (message) =>
                        message.role === "assistant" &&
                        message.contextScopeId === request.contextScopeId,
                    )
                    .flatMap((message) =>
                      message.role === "assistant"
                        ? (message.modelRequests ?? []).filter(
                            (record) =>
                              record.outcome === "running" &&
                              record.purpose === request.purpose,
                          )
                        : [],
                    )
                : [];
            if (request.purpose === "agent-step")
              expect(candidates).toHaveLength(1);
            providerCalls.push({
              sequence,
              observedAt: new Date().toISOString(),
              sessionId: request.sessionId,
              contextScopeId: request.contextScopeId,
              purpose: request.purpose,
              identity: candidates[0],
              userContents: request.messages.flatMap((message) =>
                message.role === "user" && typeof message.content === "string"
                  ? [message.content]
                  : [],
              ),
            });
          },
        },
      );
      sessionDirectory = session.root;
      const backend = session.backend;
      const fixture = join(session.root, "workspace", "continuation");
      await mkdir(fixture);
      const script = join(fixture, "gate.cjs");
      await writeFile(
        script,
        `const fs=require('node:fs');const path=require('node:path');const side=process.argv[2];fs.writeFileSync(path.join(__dirname,side+'.start'),'ready');const deadline=setTimeout(()=>process.exit(2),150000);const timer=setInterval(()=>{if(fs.existsSync(path.join(__dirname,side+'.release'))){clearInterval(timer);clearTimeout(deadline);process.stdout.write('REPORT_'+side+'_COMPLETE_7261')}},25);`,
      );
      const commands = ["A", "B"].map((side) => `node '${script}' ${side}`);
      const parts = (): ToolPart[] =>
        getDatabase()
          .prepare<{ data: string }>("SELECT data FROM part WHERE type='tool'")
          .all()
          .map((row) => JSON.parse(row.data) as ToolPart);
      off = backend.subscribeEvents((event) => {
        if (event.type !== "permission.requested") return;
        const work = (async (): Promise<void> => {
          const part = parts().find(
            (p) =>
              p.callId === event.request.callId &&
              p.sessionId === event.request.sessionId,
          );
          const allow =
            part?.tool === "bash" &&
            commands.includes(String(part.state.input.command));
          const choice = event.request.choices.find((choice) =>
            allow ? choice.id === "allow_once" : choice.intent === "deny",
          );
          if (!choice) throw new Error("No scoped permission response");
          if (!allow) permissionErrors.push("UNEXPECTED_PERMISSION_TOOL");
          await backend.respondPermission(event.request.id, {
            choiceId: choice.id,
            remember: false,
          });
        })().catch(() => {
          permissionErrors.push("Permission response failed");
        });
        pending.add(work);
        void work.finally(() => pending.delete(work));
      });
      const token = randomUUID();
      const clientId = randomUUID();
      server = createDaemonHttpServer({
        backend,
        authToken: token,
        host: "127.0.0.1",
        port: 0,
      });
      await server.start();
      async function http<T>(path: string, body?: unknown): Promise<T> {
        const response = await fetchLocal((server?.url ?? "") + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-ohbaby-client-id": clientId,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(300000),
        });
        if (!response.ok)
          throw new Error(`HTTP ${String(response.status)}: ${path}`);
        return (await response.json()) as T;
      }
      await http("/v1/clients", { clientId });
      phase = "background-dispatch";
      const receipt = await http<UiPromptReceipt>("/v1/prompts", {
        clientRequestId: randomUUID(),
        text: `Controlled background execution acceptance. Use only select_tools and subagent_run yourself; do not use status polling, skill, shell, or file tools in the parent. Activate subagent_run if necessary, then dispatch TWO independent generic subagents in the SAME response, mode=background explicitly. Child A must execute bash exactly ${JSON.stringify(commands[0])}; child B exactly ${JSON.stringify(commands[1])}. Tell both children: only select_tools and that exact bash command (timeout=180000) are permitted, no skill or other tools, no retries; final report must include the exact command output and a short explanation. These are controlled fixture commands waiting for external release. After dispatch, briefly report that you are waiting and end your model response. Runtime will deliver their final reports automatically in this same task. Do not call subagent_status or close useful work. After BOTH reports arrive, return both exact REPORT markers and incorporate any later user instruction.`,
      });
      const store = new DatabaseSubagentExecutionStore();
      await until(async () => {
        try {
          await Promise.all(
            ["A", "B"].map((side) => readFile(join(fixture, side + ".start"))),
          );
          return true;
        } catch {
          return false;
        }
      }, "both real child commands started");
      const executions = await store.list({
        parentSessionId: receipt.sessionId,
      });
      expect(executions).toHaveLength(2);
      const rootRunId = executions[0].rootRunId;
      expect(
        executions.every(
          (execution) =>
            execution.rootRunId === rootRunId &&
            execution.requesterRunId === rootRunId &&
            execution.mode === "background",
        ),
      ).toBe(true);
      expect(
        new Set(executions.map((execution) => execution.childRunId)).size,
      ).toBe(2);
      const sides = new Map(
        executions.map((execution) => {
          const command = parts().find(
            (part) =>
              part.tool === "bash" &&
              part.sessionId === execution.childSessionId &&
              part.contextScopeId === execution.childScopeId,
          )?.state.input.command;
          const side =
            command === commands[0]
              ? "A"
              : command === commands[1]
                ? "B"
                : undefined;
          expect(side).toBeDefined();
          return [execution.executionId, side];
        }),
      );
      phase = "steer-and-partial-completion";
      const inputs = (): CurrentRunInputRecord[] =>
        getDatabase()
          .prepare<{ data: string }>(
            "SELECT data FROM current_run_input WHERE run_id=?",
          )
          .all(rootRunId)
          .map((row) => JSON.parse(row.data) as CurrentRunInputRecord);
      // Keep the real production 60-second deadline; do not accelerate the
      // coordinator or infer delivery from an input merely being accepted.
      phase = "real-deadline-observation";
      await until(
        () =>
          inputs().some(
            (input) =>
              input.observation?.reason === "deadline" &&
              input.processedRequestId !== undefined,
          ),
        "production deadline included in a successful real provider request",
      );
      const deadlineInput = inputs().find(
        (input) =>
          input.observation?.reason === "deadline" &&
          input.processedRequestId !== undefined,
      );
      expect(deadlineInput).toBeDefined();
      const deadlineCall = providerCalls.find(
        (call) =>
          call.identity?.requestId === deadlineInput?.processedRequestId,
      );
      expect(deadlineCall?.identity?.inputIds).toContain(
        deadlineInput?.inputId,
      );
      expect(
        deadlineCall?.userContents.some((content) =>
          content.includes(messageText(deadlineInput?.messageId ?? "")),
        ),
      ).toBe(true);
      expect(
        (await store.list({ parentSessionId: receipt.sessionId })).every(
          (execution) => execution.status === "running",
        ),
      ).toBe(true);
      evidence.deadlineObservation = {
        inputId: deadlineInput?.inputId,
        observation: deadlineInput?.observation,
        processedRequestId: deadlineInput?.processedRequestId,
        providerSequence: deadlineCall?.sequence,
        completeRuntimeBodyInProvider: true,
        childrenStillRunning: true,
        productionFirstWaitMs: 60000,
      };
      phase = "steer-and-partial-completion";
      const queued = await http<UiPromptReceipt>("/v1/prompts", {
        sessionId: receipt.sessionId,
        clientRequestId: randomUUID(),
        text: "Additional instruction for this same task: include STEER_ACCEPTED_7261 in your final answer. Keep waiting for both child reports.",
      });
      const ordinary = await http<UiPromptReceipt>("/v1/prompts", {
        sessionId: receipt.sessionId,
        clientRequestId: randomUUID(),
        text: "Separate next task: reply ORDINARY_QUEUE_7261 only. Use no tools.",
      });
      const { receipt: steer } = await http<{
        receipt: UiSteerQueuedPromptReceipt;
      }>(`/v1/prompts/${queued.promptId}/steer`, {
        expectedRunId: rootRunId,
        clientRequestId: randomUUID(),
      });
      expect(steer.userMessageId).toBe(queued.userMessageId);
      expect(steer.acceptedTargetRunId).toBe(rootRunId);
      await writeFile(join(fixture, "A.release"), "go");
      await until(
        () =>
          inputs().some(
            (i) =>
              i.source === "subagent-result" &&
              i.processedRequestId !== undefined,
          ) &&
          inputs().some(
            (i) =>
              i.source === "user-steer" && i.processedRequestId !== undefined,
          ),
        "A result and Steer processed in root",
      );
      const intermediateExecutions = await store.list({
        parentSessionId: receipt.sessionId,
      });
      expect(
        intermediateExecutions.find(
          (execution) => sides.get(execution.executionId) === "A",
        )?.status,
      ).toBe("completed");
      expect(
        intermediateExecutions.find(
          (execution) => sides.get(execution.executionId) === "B",
        )?.status,
      ).toBe("running");
      const rootAtCheckpoint = getDatabase()
        .prepare<{
          status: string;
        }>("SELECT status FROM run_ledger WHERE run_id=?")
        .get(rootRunId);
      const queueAtCheckpoint = getDatabase()
        .prepare<{
          status: string;
        }>("SELECT status FROM prompt_submission WHERE prompt_id=?")
        .get(ordinary.promptId);
      expect(rootAtCheckpoint?.status).toBe("running");
      expect(queueAtCheckpoint?.status).toBe("queued");
      evidence.intermediate = {
        observedAt: new Date().toISOString(),
        rootRunId,
        rootStatus: rootAtCheckpoint?.status,
        ordinaryPromptId: ordinary.promptId,
        ordinaryStatus: queueAtCheckpoint?.status,
        executions: intermediateExecutions.map((execution) => ({
          executionId: execution.executionId,
          side: sides.get(execution.executionId),
          rootRunId: execution.rootRunId,
          childRunId: execution.childRunId,
          status: execution.status,
        })),
        inputs: inputs().map((input) => ({
          inputId: input.inputId,
          source: input.source,
          processedRequestId: input.processedRequestId,
        })),
      };
      phase = "final-completion";
      await writeFile(join(fixture, "B.release"), "go");
      const { completion } = await http<{ completion: UiPromptCompletion }>(
        `/v1/prompts/${receipt.promptId}/completion`,
      );
      expect(completion.prompt.status).toBe("succeeded");
      const next = await http<{ completion: UiPromptCompletion }>(
        `/v1/prompts/${ordinary.promptId}/completion`,
      );
      expect(next.completion.prompt.status).toBe("succeeded");
      const allExecutions = await store.list({
        parentSessionId: receipt.sessionId,
      });
      expect(
        allExecutions.every(
          (e) => e.status === "completed" && e.delivery.state === "processed",
        ),
      ).toBe(true);
      expect(completion.prompt.runId).toBe(rootRunId);
      const ordinaryRunId = next.completion.prompt.runId;
      expect(ordinaryRunId).toBeDefined();
      expect(ordinaryRunId).not.toBe(rootRunId);
      const rootRun = getDatabase()
        .prepare<{
          ended_at: number | null;
        }>("SELECT ended_at FROM run_ledger WHERE run_id=?")
        .get(rootRunId);
      const ordinaryRun = getDatabase()
        .prepare<{ started_at: number | null }>(
          "SELECT started_at FROM run_ledger WHERE run_id=?",
        )
        .get(ordinaryRunId ?? "");
      expect(rootRun?.ended_at).toEqual(expect.any(Number));
      expect(ordinaryRun?.started_at).toEqual(expect.any(Number));
      expect(ordinaryRun?.started_at ?? -1).toBeGreaterThanOrEqual(
        rootRun?.ended_at ?? Infinity,
      );
      const messages = storedMessages(receipt.sessionId);
      const requestRecords = messages.flatMap((message) =>
        message.role === "assistant" ? (message.modelRequests ?? []) : [],
      );
      const businessInputs = inputs().filter(
        (input) => input.source !== "subagent-status",
      );
      expect(businessInputs).toHaveLength(3);
      const deliveryProofs = businessInputs.map((input) => {
        const success = requestRecords.find(
          (record) => record.requestId === input.processedRequestId,
        );
        expect(success).toMatchObject({ runId: rootRunId, outcome: "success" });
        expect(success?.inputIds).toContain(input.inputId);
        const actualCalls = providerCalls.filter(
          (call) => call.identity?.requestId === input.processedRequestId,
        );
        expect(actualCalls).toHaveLength(1);
        const call = actualCalls[0];
        expect(call.identity?.runId).toBe(rootRunId);
        expect(call.identity?.inputIds).toContain(input.inputId);
        const runtime = messages.find(
          (message) => message.id === input.messageId,
        );
        expect(runtime).toMatchObject({
          role: "user",
          runId: rootRunId,
          runtimeInput: {
            inputId: input.inputId,
            targetRunId: rootRunId,
            kind: input.source,
          },
        });
        const text = messageText(input.messageId);
        expect(text.length).toBeGreaterThan(0);
        expect(
          call.userContents.some((content) => content.includes(text)),
        ).toBe(true);
        const execution =
          input.source === "subagent-result"
            ? allExecutions.find(
                (execution) => execution.delivery.inputId === input.inputId,
              )
            : undefined;
        if (input.source === "subagent-result") {
          expect(execution?.output?.length).toBeGreaterThan(0);
          expect(text).toContain(execution?.output ?? "");
          expect(
            call.userContents.some((content) =>
              content.includes(execution?.output ?? ""),
            ),
          ).toBe(true);
        }
        return {
          inputId: input.inputId,
          source: input.source,
          messageId: input.messageId,
          runId: rootRunId,
          processedRequestId: input.processedRequestId,
          successfulRequest: success,
          providerSequence: call.sequence,
          membershipVerified: true,
          runtimeUserContentSha256: digest(text),
          runtimeUserContentBytes: Buffer.byteLength(text),
          completeRuntimeBodyInProvider: true,
          executionId: execution?.executionId,
          fullChildOutputVerified: execution === undefined ? undefined : true,
        };
      });
      function finalText(runId: string): { messageId: string; text: string } {
        const latest = requestRecords
          .filter(
            (record) => record.runId === runId && record.outcome === "success",
          )
          .sort(
            (left, right) =>
              right.step - left.step || right.startedAt - left.startedAt,
          )[0];
        expect(latest).toBeDefined();
        return {
          messageId: latest.messageId,
          text: messageText(latest.messageId),
        };
      }
      const rootFinal = finalText(rootRunId);
      const ordinaryFinal = finalText(ordinaryRunId ?? "");
      for (const marker of [
        "REPORT_A_COMPLETE_7261",
        "REPORT_B_COMPLETE_7261",
        "STEER_ACCEPTED_7261",
      ])
        expect(rootFinal.text).toContain(marker);
      expect(rootFinal.text).not.toContain("ORDINARY_QUEUE_7261");
      expect(ordinaryFinal.text.trim()).toBe("ORDINARY_QUEUE_7261");
      evidence.deliveryProofs = deliveryProofs;
      evidence.order = {
        rootRunId,
        rootEndedAt: rootRun?.ended_at,
        ordinaryPromptId: ordinary.promptId,
        ordinaryRunId,
        ordinaryStartedAt: ordinaryRun?.started_at,
        ordinaryStartsAfterRootEnd: true,
      };
      evidence.finalAnswers = {
        root: {
          runId: rootRunId,
          messageId: rootFinal.messageId,
          sha256: digest(rootFinal.text),
          allRequiredMarkers: true,
        },
        ordinary: {
          runId: ordinaryRunId,
          messageId: ordinaryFinal.messageId,
          sha256: digest(ordinaryFinal.text),
          exactExpectedMarker: true,
        },
      };
      evidence.providerIdentityChain = providerCalls.map(
        ({ userContents, ...call }) => ({
          ...call,
          userContentHashes: userContents.map(digest),
        }),
      );
      expect(parts().filter((p) => p.tool === "subagent_status")).toHaveLength(
        0,
      );
      expect(permissionErrors).toEqual([]);
      Object.assign(evidence, {
        assertionsPassed: true,
        rootRunId,
        contextWindow: session.contextWindow,
        executionCount: allExecutions.length,
        steerSameMessage: true,
        ordinaryQueuedUntilRootEnd: true,
        statusCalls: 0,
        inputs: inputs().map(({ inputId, source, processedRequestId }) => ({
          inputId,
          source,
          processedRequestId,
        })),
        requests: session.providerRequests,
        outputs: allExecutions.map((e) => ({
          executionId: e.executionId,
          bytes: Buffer.byteLength(e.output ?? ""),
          sha256: createHash("sha256")
            .update(e.output ?? "")
            .digest("hex"),
        })),
      });
      assertionsPassed = true;
    } catch (error) {
      const code =
        error instanceof Error && error.name === "AssertionError"
          ? "ASSERTION_FAILED"
          : "REAL_CONTINUATION_FAILED";
      Object.assign(evidence, { error: { phase, code }, permissionErrors });
      failureCode = code;
      sessionDirectory ??=
        getFormalSetupFailureEvidence(error)?.diagnosticWorkspace;
    } finally {
      const cleanupErrors = await collectFormalCleanupErrors([
        {
          code: "UNSUBSCRIBE_FAILED",
          run: (): void => {
            off();
          },
        },
        {
          code: "PERMISSION_DRAIN_FAILED",
          run: async (): Promise<void> => {
            await boundedCleanup(Promise.allSettled([...pending]));
            if (permissionErrors.length) throw new Error("PERMISSION_ERRORS");
          },
        },
        {
          code: "SERVER_STOP_FAILED",
          run: (): Promise<void> =>
            boundedCleanup(server?.stop() ?? Promise.resolve()),
        },
        {
          code: "SESSION_CLOSE_FAILED",
          run: (): Promise<void> =>
            boundedCleanup(session?.close() ?? Promise.resolve()),
        },
        {
          code: "ENVIRONMENT_RESTORE_FAILED",
          run: (): void => {
            os.homedir = oldHome;
            if (oldStorage === undefined)
              delete process.env.OHBABY_STORAGE_ROOT;
            else process.env.OHBABY_STORAGE_ROOT = oldStorage;
          },
        },
        {
          code: "SESSION_DIRECTORY_REMOVE_FAILED",
          run: (): Promise<void> | undefined =>
            sessionDirectory
              ? rm(sessionDirectory, { recursive: true, force: true })
              : undefined,
        },
        {
          code: "ISOLATED_DIRECTORY_REMOVE_FAILED",
          run: (): Promise<void> =>
            rm(isolated, { recursive: true, force: true }),
        },
      ]);
      Object.assign(evidence, {
        passed: assertionsPassed && cleanupErrors.length === 0,
        finishedAt: new Date().toISOString(),
        cleanup: { passed: cleanupErrors.length === 0, errors: cleanupErrors },
      });
      const evidenceDir = join(
        process.cwd(),
        ".ohbaby/test-evidence/improve-3",
      );
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(
        join(evidenceDir, "real-background-steer.json"),
        JSON.stringify(evidence, null, 2),
      );
      if (cleanupErrors.length)
        failureCode ??= "REAL_CONTINUATION_CLEANUP_FAILED";
    }
    if (failureCode) throw new Error(failureCode);
  },
);
