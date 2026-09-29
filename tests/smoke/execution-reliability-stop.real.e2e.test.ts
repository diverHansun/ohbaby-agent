import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  UiPermissionBinding,
  UiPromptCompletion,
  UiPromptReceipt,
  UiSessionControl,
  UiSnapshot,
} from "ohbaby-sdk";
import type {
  Message,
  ToolPart,
} from "../../packages/ohbaby-agent/src/core/message/types.js";
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { DatabaseSubagentExecutionStore } from "../../packages/ohbaby-agent/src/agents/subagents/execution-store.js";
import { createDaemonHttpServer } from "../../packages/ohbaby-server/src/runtime/daemon/server.js";
import {
  collectFormalCleanupErrors,
  createFormalCacheSession,
  getFormalSetupFailureEvidence,
} from "./formal-cache-session.js";
import {
  hasValidFormalToolPairing,
  type FormalCacheGenerationEvidence,
} from "./formal-cache-observer.js";

const profileId = "zenmux-gpt56-luna-responses-context";
const lateMarker = "STOP_A_LATE_OUTPUT_8913";
const nextMarker = "STOP_B_ACTUAL_ONCE_8913";
const historyMarker = "STOP_C_HISTORY_ACCEPTED_8913";

async function until(
  check: () => boolean | Promise<boolean>,
  code: string,
  timeout = 120000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(code);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("FIXTURE_PROCESS_PROBE_FAILED");
  }
}

function tools(): ToolPart[] {
  return getDatabase()
    .prepare<{ data: string }>("SELECT data FROM part WHERE type='tool'")
    .all()
    .map((row) => JSON.parse(row.data) as ToolPart);
}

function messages(sessionId: string): Message[] {
  return getDatabase()
    .prepare<{ data: string }>(
      "SELECT data FROM message WHERE session_id=? ORDER BY created_at,id",
    )
    .all(sessionId)
    .map((row) => JSON.parse(row.data) as Message);
}

async function runStopScenario(
  scenario: "root-bash" | "two-children",
): Promise<void> {
  const maxRequests = scenario === "two-children" ? 24 : 18;
  // Capture loopback fetch before the existing helper installs its provider-only observer.
  const localFetch = globalThis.fetch;
  const isolated = await mkdtemp(join(os.tmpdir(), "improve4-real-stop-"));
  const oldHomedir = os.homedir;
  const oldStorage = process.env.OHBABY_STORAGE_ROOT;
  os.homedir = (): string => isolated;
  process.env.OHBABY_STORAGE_ROOT = join(isolated, "storage");
  let session: Awaited<ReturnType<typeof createFormalCacheSession>> | undefined;
  let server: ReturnType<typeof createDaemonHttpServer> | undefined;
  let sessionRoot: string | undefined;
  const ownedPids = new Set<number>();
  const pidPaths: string[] = [];
  let unsubscribe = (): void => undefined;
  let phase = "setup";
  let failureCode: string | undefined;
  let diagnosis: Record<string, unknown> = {};
  const requestPhases = new Map<number, string>();
  const requestScopes: { sessionId?: string; contextScopeId?: string }[] = [];
  const permissionErrors: string[] = [];
  const pendingPermissions = new Set<Promise<void>>();
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  try {
    session = await createFormalCacheSession(profileId, {
      maxRequests,
      handleControlledPermissions: false,
      onProviderRequest(request, sequence): void {
        requestPhases.set(sequence, phase);
        requestScopes.push({
          sessionId: request.sessionId,
          contextScopeId: request.contextScopeId,
        });
      },
    });
    sessionRoot = session.root;
    const backend = session.backend;
    const fixture = join(session.root, "workspace", "stop-fixture");
    await mkdir(fixture);
    const scriptB = join(fixture, "once-b.cjs");
    const countPath = join(fixture, "b.executions");
    const sides = scenario === "two-children" ? ["left", "right"] : ["root"];
    const scripts = sides.map((side) => ({
      side,
      script: join(fixture, `stop-${side}.cjs`),
      pid: join(fixture, `${side}.pid`),
      stopped: join(fixture, `${side}.stopped`),
      count: join(fixture, `${side}.executions`),
    }));
    pidPaths.push(...scripts.map((item) => item.pid));
    // All file writes are restricted to this fixture. There are no descendants.
    // Emit after SIGTERM to exercise late output while production cleanup drains.
    for (const item of scripts)
      await writeFile(
        item.script,
        `const fs=require('node:fs');const path=require('node:path');
const hold=setInterval(()=>{},1000);const deadline=setTimeout(()=>process.exit(2),180000);
process.once('SIGTERM',()=>{fs.writeSync(1,'${lateMarker}_${item.side}');fs.writeFileSync(path.join(__dirname,'${item.side}.stopped'),'signal');setTimeout(()=>{clearInterval(hold);clearTimeout(deadline);process.exit(0)},75)});
fs.appendFileSync(path.join(__dirname,'${item.side}.executions'),'once\\n');fs.writeFileSync(path.join(__dirname,'${item.side}.pid'),String(process.pid));
`,
      );
    await writeFile(
      scriptB,
      `const fs=require('node:fs');const path=require('node:path');fs.appendFileSync(path.join(__dirname,'b.executions'),'once\\n');process.stdout.write('${nextMarker}');`,
    );
    const commandsA = scripts.map((item) => `node '${item.script}'`);
    const commandB = `node '${scriptB}'`;
    unsubscribe = backend.subscribeEvents((event) => {
      if (event.type !== "permission.requested") return;
      const work = (async (): Promise<void> => {
        const part = tools().find(
          (item) =>
            item.callId === event.request.callId &&
            item.sessionId === event.request.sessionId,
        );
        const allowed =
          part?.tool === "bash" &&
          [...commandsA, commandB].includes(String(part.state.input.command)) &&
          part.state.input.run_in_background !== true;
        const choice = event.request.choices.find((item) =>
          allowed ? item.id === "allow_once" : item.intent === "deny",
        );
        if (!choice) throw new Error("NO_SAFE_PERMISSION_CHOICE");
        if (!allowed) permissionErrors.push("UNEXPECTED_PERMISSION_TOOL");
        await backend.respondPermission(event.request.id, {
          choiceId: choice.id,
          remember: false,
        });
      })().catch(() => {
        permissionErrors.push("PERMISSION_RESPONSE_FAILED");
      });
      pendingPermissions.add(work);
      void work.finally(() => pendingPermissions.delete(work));
    });
    const authToken = randomUUID();
    const clientId = randomUUID();
    server = createDaemonHttpServer({
      backend,
      authToken,
      host: "127.0.0.1",
      port: 0,
    });
    const http = server;
    async function request<T>(route: string, body?: unknown): Promise<T> {
      const response = await localFetch(http.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "x-ohbaby-client-id": clientId,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180000),
      });
      // Do not include response bodies, provider errors or request headers in diagnostics.
      if (!response.ok)
        throw new Error(`LOOPBACK_HTTP_${String(response.status)}`);
      return (await response.json()) as T;
    }
    async function snapshot(): Promise<UiSnapshot> {
      return (await request<{ snapshot: UiSnapshot }>("/v1/snapshot")).snapshot;
    }
    async function completion(
      receipt: UiPromptReceipt,
    ): Promise<UiPromptCompletion> {
      return (
        await request<{ completion: UiPromptCompletion }>(
          `/v1/prompts/${receipt.promptId}/completion`,
        )
      ).completion;
    }
    await server.start();
    await request("/v1/clients", { clientId });
    const binding = await request<
      UiPermissionBinding & { session: { id: string } }
    >("/v1/sessions", {});
    const sessionId = binding.session.id;
    const query = new URLSearchParams({
      runtimeEpoch: binding.permissionEpoch,
      bindingGeneration: String(binding.bindingGeneration),
    });
    phase = "start-A";
    const bashInstruction = (command: string): string =>
      `If necessary activate bash via select_tools. Invoke bash exactly once with command ${JSON.stringify(command)}, timeout=180000, run_in_background=false. This is an authorized test script confined to the temporary fixture directory. Wait for its result. No other commands, retries, subagents or background jobs.`;
    const instructionA =
      scenario === "root-bash"
        ? `Controlled Stop acceptance. ${bashInstruction(commandsA[0])}`
        : `Controlled multi-child Stop acceptance. Activate subagent_run via select_tools if needed. Create exactly TWO DIFFERENT new generic subagents in background mode, one named stop-left and one named stop-right. Send BOTH subagent_run calls in the SAME tool-call response. Left child's prompt: ${JSON.stringify(bashInstruction(commandsA[0]))}. Right child's prompt: ${JSON.stringify(bashInstruction(commandsA[1]))}. After both receipts, finish a brief progress response and let the runtime wait for the two results. Never poll status, close children, execute root tools other than select_tools/subagent_run, create more children, or retry delegation.`;
    const a = await request<UiPromptReceipt>("/v1/prompts", {
      sessionId,
      clientRequestId: randomUUID(),
      text: instructionA,
    });
    await until(
      () => scripts.every((item) => existsSync(item.pid)),
      "A_NEVER_ENTERED_BASH",
    );
    for (const item of scripts) {
      const pid = Number(await readFile(item.pid, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      expect(processAlive(pid)).toBe(true);
      ownedPids.add(pid);
    }
    expect(ownedPids.size).toBe(scripts.length);
    const atStart = await snapshot();
    const aPrompt = atStart.prompts?.find(
      (item) => item.promptId === a.promptId,
    );
    expect(aPrompt?.status).toBe("running");
    const aRunId = aPrompt?.runId;
    if (!aRunId) throw new Error("A_MISSING_RUN");
    const aCalls = tools().filter(
      (item) =>
        item.tool === "bash" &&
        commandsA.includes(String(item.state.input.command)),
    );
    expect(aCalls).toHaveLength(scripts.length);
    expect(aCalls.every((item) => item.state.status === "running")).toBe(true);
    const executionStore = new DatabaseSubagentExecutionStore();
    const children = await executionStore.listByRootRun(aRunId);
    expect(children).toHaveLength(scenario === "two-children" ? 2 : 0);
    for (const child of children) {
      expect(child.status).toBe("running");
      expect(child.mode).toBe("background");
      expect(child.childRunId).toBeDefined();
      expect(
        aCalls.some(
          (call) =>
            call.sessionId === child.childSessionId &&
            call.contextScopeId === child.childScopeId,
        ),
      ).toBe(true);
    }
    expect(new Set(children.map((child) => child.subagentId)).size).toBe(
      children.length,
    );
    const childRequestCount = (): number =>
      requestScopes.filter((request) =>
        children.some(
          (child) =>
            request.sessionId === child.childSessionId &&
            request.contextScopeId === child.childScopeId,
        ),
      ).length;
    const childRequestsAtStop = childRequestCount();
    expect(childRequestsAtStop).toBeGreaterThanOrEqual(children.length);
    const aMessageIds = new Set(
      messages(sessionId)
        .filter((item) => item.runId === aRunId)
        .map((item) => item.id),
    );
    const replayACalls =
      scenario === "root-bash"
        ? aCalls
        : tools().filter(
            (item) =>
              aMessageIds.has(item.messageId) && item.tool === "subagent_run",
          );
    expect(replayACalls).toHaveLength(scripts.length);

    phase = "queue-B";
    const bBody = {
      sessionId,
      clientRequestId: randomUUID(),
      text: `Independent ordinary request B: execute bash exactly once with command ${JSON.stringify(commandB)}, timeout=5000, run_in_background=false. Reply only with its actual output. Do not continue, retry or report the previous request A; no other commands or subagents.`,
    };
    const b = await request<UiPromptReceipt>("/v1/prompts", bBody);
    expect(b.status).toBe("queued");
    // Retrying durable admission must not execute this normal queued request twice.
    expect(
      (await request<UiPromptReceipt>("/v1/prompts", bBody)).promptId,
    ).toBe(b.promptId);
    const atQueue = await snapshot();
    expect(
      atQueue.prompts?.find((item) => item.promptId === b.promptId)?.runId,
    ).toBeUndefined();
    expect(
      messages(sessionId).some((item) => item.id === b.userMessageId),
    ).toBe(false);
    expect(existsSync(countPath)).toBe(false);
    const { control } = await request<{ control: UiSessionControl }>(
      `/v1/sessions/${sessionId}/control?${query.toString()}`,
    );
    expect(control.runId).toBe(aRunId);

    phase = "stop-A-drain-B";
    await request(`/v1/sessions/${sessionId}/abort`, {
      runId: aRunId,
      runtimeEpoch: binding.permissionEpoch,
      bindingGeneration: binding.bindingGeneration,
    });
    const aDone = await completion(a);
    diagnosis = {
      aStatus: aDone.prompt.status,
      aErrorCode: aDone.prompt.error?.code,
    };
    expect(aDone.prompt.status).toBe("interrupted");
    expect(aDone.prompt.endTimeSource).toBeUndefined();
    const bDone = await completion(b);
    diagnosis = {
      ...diagnosis,
      bStatus: bDone.prompt.status,
      bErrorCode: bDone.prompt.error?.code,
    };
    expect(bDone.prompt.status).toBe("succeeded");
    expect(bDone.prompt.runId).toBeDefined();
    expect(bDone.prompt.runId).not.toBe(aRunId);
    await until(
      () => [...ownedPids].every((pid) => !processAlive(pid)),
      "A_PROCESS_SURVIVED_STOP",
      5000,
    );
    for (const item of scripts) {
      expect(existsSync(item.stopped)).toBe(true);
      expect((await readFile(item.count, "utf8")).trim().split("\n")).toEqual([
        "once",
      ]);
    }
    expect((await readFile(countPath, "utf8")).trim().split("\n")).toEqual([
      "once",
    ]);
    const aTerminalTools = tools().filter((item) =>
      aCalls.some((call) => call.id === item.id),
    );
    diagnosis = {
      ...diagnosis,
      aToolStatuses: aTerminalTools.map((item) => item.state.status),
    };
    expect(
      aTerminalTools.every((item) => item.state.status === "aborted"),
    ).toBe(true);
    const stoppedChildren = await executionStore.listByRootRun(aRunId);
    expect(
      stoppedChildren.every((child) => child.status === "interrupted"),
    ).toBe(true);
    for (const child of stoppedChildren) {
      expect(
        getDatabase()
          .prepare("SELECT status FROM run_ledger WHERE run_id=?")
          .get(child.childRunId ?? ""),
      ).toEqual({ status: "interrupted" });
      expect(
        getDatabase()
          .prepare(
            "SELECT current_run_id,current_input,pending_queue FROM subagent_instance WHERE subagent_id=?",
          )
          .get(child.subagentId),
      ).toEqual({
        current_run_id: null,
        current_input: null,
        pending_queue: "[]",
      });
    }
    const childTerminalHistory = JSON.stringify(stoppedChildren);
    const bTools = tools().filter(
      (item) => item.tool === "bash" && item.state.input.command === commandB,
    );
    expect(bTools).toHaveLength(1);
    expect(bTools[0].state.status).toBe("completed");
    const bRunId = bDone.prompt.runId;
    if (!bRunId) throw new Error("B_MISSING_RUN");
    const beforeC = await snapshot();
    const bMessages =
      beforeC.sessions
        .find((item) => item.id === sessionId)
        ?.messages.filter((item) => item.runId === bRunId) ?? [];
    const bText = bMessages
      .flatMap((item) =>
        item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      .join("\n");
    expect(bText).toContain(nextMarker);
    expect(JSON.stringify(bMessages)).not.toContain(lateMarker);
    expect(
      messages(sessionId).filter((item) => item.id === b.userMessageId),
    ).toHaveLength(1);
    const aHistory = JSON.stringify(
      messages(sessionId).filter((item) => item.runId === aRunId),
    );
    const aToolHistory = JSON.stringify(aTerminalTools);
    diagnosis = {
      aStatus: aDone.prompt.status,
      bStatus: bDone.prompt.status,
      aBSeparateRuns: aRunId !== bRunId,
      bExecutionCount: 1,
      lateSignalObserved: true,
      lateOutputAbsentFromB: true,
      childExecutions: children.length,
      childProcesses: scenario === "two-children" ? ownedPids.size : 0,
      childRequestsAtStop,
    };

    phase = "C-history-replay";
    const c = await request<UiPromptReceipt>("/v1/prompts", {
      sessionId,
      clientRequestId: randomUUID(),
      text: `Protocol history acceptance C. No tools or retries. Reply exactly ${historyMarker}.`,
    });
    const cDone = await completion(c);
    diagnosis = {
      ...diagnosis,
      cStatus: cDone.prompt.status,
      cErrorCode: cDone.prompt.error?.code,
    };
    expect(cDone.prompt.status).toBe("succeeded");
    expect(new Set([aRunId, bRunId, cDone.prompt.runId]).size).toBe(3);
    const final = await snapshot();
    const cText = final.sessions
      .find((item) => item.id === sessionId)
      ?.messages.filter(
        (item) =>
          item.runId === cDone.prompt.runId && item.role === "assistant",
      )
      .flatMap((item) =>
        item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )
      .join("\n");
    expect(cText?.trim()).toBe(historyMarker);
    expect(
      JSON.stringify(
        messages(sessionId).filter((item) => item.runId === aRunId),
      ),
    ).toBe(aHistory);
    expect(
      JSON.stringify(
        tools().filter((item) => aCalls.some((call) => call.id === item.id)),
      ),
    ).toBe(aToolHistory);
    expect(JSON.stringify(await executionStore.listByRootRun(aRunId))).toBe(
      childTerminalHistory,
    );
    expect(childRequestCount()).toBe(childRequestsAtStop);
    for (const item of scripts)
      expect((await readFile(item.count, "utf8")).trim().split("\n")).toEqual([
        "once",
      ]);
    expect((await readFile(countPath, "utf8")).trim().split("\n")).toEqual([
      "once",
    ]);
    const runs = getDatabase()
      .prepare<{
        run_id: string;
        status: string;
        inputs_close_reason: string | null;
      }>(
        "SELECT run_id,status,inputs_close_reason FROM run_ledger WHERE session_id=? ORDER BY created_at,run_id",
      )
      .all(sessionId);
    expect(runs).toHaveLength(3);
    expect(runs.find((run) => run.run_id === aRunId)).toMatchObject({
      status: "interrupted",
      inputs_close_reason: "user-stop",
    });
    expect(runs.filter((run) => run.status === "succeeded")).toHaveLength(2);
    await Promise.all([...pendingPermissions]);
    expect(permissionErrors).toEqual([]);
    const providerRequests = session.providerRequests;
    await until(
      () => providerRequests.every((item) => item.settled),
      "PROVIDER_DID_NOT_SETTLE",
      5000,
    );
    const callHash = (id: string): string =>
      createHash("sha256").update(id).digest("hex");
    const cRequests = session.wire.filter(
      (row): row is FormalCacheGenerationEvidence =>
        row.kind === "generation" &&
        requestPhases.get(row.context?.id ?? -1) === phase &&
        [...replayACalls, bTools[0]].every((call) =>
          row.toolPairing?.calls.includes(callHash(call.callId)),
        ),
    );
    expect(cRequests.length).toBeGreaterThan(0);
    expect(
      cRequests.every(
        (row) =>
          row.protocol === "openai-responses" &&
          row.status === 200 &&
          hasValidFormalToolPairing(row.toolPairing),
      ),
    ).toBe(true);
    expect(session.wire.length).toBeLessThanOrEqual(maxRequests);
    diagnosis = {
      ...diagnosis,
      cStatus: cDone.prompt.status,
      totalRuns: runs.length,
      cToolPairingAccepted: true,
      aHistoryStableAfterC: true,
      cRequestsWithBothToolPairs: cRequests.length,
    };
    phase = "verified";
  } catch (error) {
    // Raw SDK/HTTP errors can contain provider request details; only stable codes escape.
    failureCode = `REAL_STOP_FAILED_${phase}`;
    if (!session) {
      const setup = getFormalSetupFailureEvidence(error);
      sessionRoot = setup?.diagnosticWorkspace;
      diagnosis = { setupCleanupErrors: setup?.cleanupErrors ?? [] };
    } else {
      diagnosis = {
        ...diagnosis,
        failureType: error instanceof Error ? error.name : "unknown",
        ...(error instanceof Error && /^[A-Z][A-Z_0-9]+$/.test(error.message)
          ? { code: error.message }
          : {}),
      };
    }
  } finally {
    const cleanupErrors = await collectFormalCleanupErrors([
      { code: "PERMISSION_UNSUBSCRIBE_FAILED", run: unsubscribe },
      {
        code: "SERVER_STOP_FAILED",
        run: async (): Promise<void> => {
          await server?.stop();
        },
      },
      {
        code: "PERMISSION_DRAIN_FAILED",
        run: async (): Promise<void> => {
          await Promise.allSettled([...pendingPermissions]);
        },
      },
      {
        code: "SESSION_CLOSE_FAILED",
        run: async (): Promise<void> => {
          await session?.close();
        },
      },
      {
        code: "FIXTURE_PROCESS_CLEANUP_FAILED",
        run: async (): Promise<void> => {
          // Recover a PID even if an earlier assertion failed before observing both children.
          for (const path of pidPaths)
            if (existsSync(path)) {
              const pid = Number(await readFile(path, "utf8"));
              if (Number.isSafeInteger(pid) && pid > 1) ownedPids.add(pid);
            }
          const failures = await collectFormalCleanupErrors(
            [...ownedPids].map((pid) => ({
              code: "OWNED_CHILD_CLEANUP_FAILED",
              run: async (): Promise<void> => {
                if (!processAlive(pid)) return;
                process.kill(pid, "SIGKILL");
                await until(
                  () => !processAlive(pid),
                  "FIXTURE_PROCESS_STILL_ALIVE",
                  5000,
                );
              },
            })),
          );
          if (failures.length) throw new Error("OWNED_CHILD_CLEANUP_FAILED");
        },
      },
      {
        code: "ENVIRONMENT_RESTORE_FAILED",
        run: (): void => {
          os.homedir = oldHomedir;
          if (oldStorage === undefined) delete process.env.OHBABY_STORAGE_ROOT;
          else process.env.OHBABY_STORAGE_ROOT = oldStorage;
        },
      },
      {
        code: "SESSION_DIRECTORY_REMOVE_FAILED",
        run: async (): Promise<void> => {
          if (sessionRoot)
            await rm(sessionRoot, { recursive: true, force: true });
        },
      },
      {
        code: "ISOLATED_DIRECTORY_REMOVE_FAILED",
        run: (): Promise<void> =>
          rm(isolated, { recursive: true, force: true }),
      },
    ]);
    if (cleanupErrors.length) failureCode ??= "REAL_STOP_CLEANUP_FAILED";
    const evidenceDir = join(process.cwd(), ".ohbaby/test-evidence/improve-4");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      join(evidenceDir, `real-stop-${attemptId}.json`),
      JSON.stringify(
        {
          attemptId,
          startedAt,
          finishedAt: new Date().toISOString(),
          profileId,
          scenario,
          model: "openai/gpt-5.6-luna",
          protocol: "openai-responses",
          entry: "persistent backend + loopback HTTP",
          maxRequests,
          passed: failureCode === undefined,
          phase,
          failureCode,
          diagnosis,
          providerRequests: session?.providerRequests.length ?? 0,
          httpRequests: session?.wire.length ?? 0,
          requests: session?.wire.map((row) => ({
            sequence: row.sequence,
            kind: row.kind,
            status: row.status,
            captureError: row.captureError,
            phase: requestPhases.get(row.context?.id ?? -1),
            ...(row.kind === "generation"
              ? {
                  protocol: row.protocol,
                  toolPairingValid: hasValidFormalToolPairing(row.toolPairing),
                  toolCalls: row.toolPairing?.calls.length,
                  toolResults: row.toolPairing?.results.length,
                }
              : {}),
          })),
          permissionErrors,
          cleanupErrors,
        },
        null,
        2,
      ) + "\n",
    );
  }
  if (failureCode) throw new Error(failureCode);
}

it.runIf(process.env.OHBABY_RUN_REAL_EXECUTION_RELIABILITY_STOP === "1")(
  "real Responses HTTP Stop seals A, runs ordinary queued B once, and accepts C with their persisted tool history",
  () => runStopScenario("root-bash"),
);

it.runIf(process.env.OHBABY_RUN_REAL_EXECUTION_RELIABILITY_CHILD_STOP === "1")(
  "real Responses HTTP Stop interrupts two background child Bash executions before B and C continue independently",
  () => runStopScenario("two-children"),
);
