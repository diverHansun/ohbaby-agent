import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  Message,
  Part,
  ToolPart,
} from "../../packages/ohbaby-agent/src/core/message/types.js";
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { DatabaseSubagentExecutionStore } from "../../packages/ohbaby-agent/src/agents/subagents/execution-store.js";
import {
  collectFormalCleanupErrors,
  createFormalCacheSession,
  getFormalSetupFailureEvidence,
} from "./formal-cache-session.js";

const marker = "SAME_CHILD_SEGMENT_TWO_7261";
const profileId =
  process.env.OHBABY_REAL_CONVERSATION_PROFILE ??
  "zenmux-gpt56-luna-responses-context";

function messages(sessionId: string): Message[] {
  return getDatabase()
    .prepare<{ data: string }>(
      "SELECT data FROM message WHERE session_id=? ORDER BY created_at,id",
    )
    .all(sessionId)
    .map((row) => JSON.parse(row.data) as Message);
}

function parts(): ToolPart[] {
  return getDatabase()
    .prepare<{ data: string }>("SELECT data FROM part WHERE type='tool'")
    .all()
    .map((row) => JSON.parse(row.data) as ToolPart);
}

function textFor(messageId: string): string {
  return getDatabase()
    .prepare<{ data: string }>(
      "SELECT data FROM part WHERE message_id=? ORDER BY order_index",
    )
    .all(messageId)
    .map((row) => JSON.parse(row.data) as Part)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
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

it.runIf(process.env.OHBABY_RUN_REAL_SUBAGENT_CONVERSATION === "1")(
  "real parent queues a second delegation to one busy child without writing its formal history early",
  async () => {
    const isolated = await mkdtemp(join(os.tmpdir(), "improve31-live-"));
    const oldHome = os.homedir;
    const oldStorage = process.env.OHBABY_STORAGE_ROOT;
    os.homedir = (): string => isolated;
    process.env.OHBABY_STORAGE_ROOT = join(isolated, "storage");
    let session:
      | Awaited<ReturnType<typeof createFormalCacheSession>>
      | undefined;
    let sessionRoot: string | undefined;
    let releasePath: string | undefined;
    let rootSessionId: string | undefined;
    let unsubscribe = (): void => undefined;
    const permissionErrors: string[] = [];
    const pendingPermissions = new Set<Promise<void>>();
    const providerUserBodies: { sessionId?: string; text: string }[] = [];
    let failure: unknown;
    let phase = "setup";
    let diagnosis: Record<string, unknown> = {};
    try {
      session = await createFormalCacheSession(profileId, {
        maxRequests: 15,
        handleControlledPermissions: false,
        onProviderRequest(request): void {
          providerUserBodies.push({
            sessionId: request.sessionId,
            text: request.messages
              .flatMap((message) =>
                message.role === "user" && typeof message.content === "string"
                  ? [message.content]
                  : [],
              )
              .join("\n"),
          });
        },
      });
      sessionRoot = session.root;
      const backend = session.backend;
      const fixture = join(session.root, "workspace", "conversation");
      await mkdir(fixture);
      const script = join(fixture, "gate.cjs");
      releasePath = join(fixture, "release");
      await writeFile(
        script,
        `const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(path.join(__dirname,'started'),'ready');const deadline=setTimeout(()=>process.exit(2),150000);const timer=setInterval(()=>{if(fs.existsSync(path.join(__dirname,'release'))){clearInterval(timer);clearTimeout(deadline);process.stdout.write('FIRST_SEGMENT_COMPLETE_7261')}},25);`,
      );
      const command = `node '${script}'`;
      unsubscribe = backend.subscribeEvents((event) => {
        if (event.type !== "permission.requested") return;
        const work = (async (): Promise<void> => {
          const part = parts().find(
            (item) =>
              item.callId === event.request.callId &&
              item.sessionId === event.request.sessionId,
          );
          const allowed =
            part?.tool === "bash" && part.state.input.command === command;
          const choice = event.request.choices.find((item) =>
            allowed ? item.id === "allow_once" : item.intent === "deny",
          );
          if (!choice) throw new Error("No scoped permission choice");
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

      const store = new DatabaseSubagentExecutionStore();
      const setup = await backend.submitPromptAndWait(
        "Controlled acceptance setup. Use select_tools to activate subagent_run, then call subagent_run exactly once with role=generic, mode=foreground and prompt 'Reply exactly READY_CHILD_7261, with no tools.' No other tools or child calls. After its reply, report READY_CHILD_7261.",
        { signal: AbortSignal.timeout(180000) },
      );
      rootSessionId = setup.prompt.sessionId;
      if (setup.prompt.status !== "succeeded")
        throw new Error(
          `Setup failed: ${JSON.stringify({
            status: setup.prompt.status,
            error: setup.prompt.error,
          })}`,
        );
      const setupRecords = await store.list({
        parentSessionId: setup.prompt.sessionId,
      });
      expect(setupRecords).toHaveLength(1);
      const seed = setupRecords[0];
      expect(seed.status).toBe("completed");
      expect(seed.childSessionId).toBeDefined();
      phase = "repeat-delegation";
      const receipt = await backend.submitPromptAccepted(
        `Controlled acceptance continuation. Use subagent_run TWICE in the SAME assistant tool-call response, with subagent_id=${JSON.stringify(seed.subagentId)} on BOTH calls and mode=background on BOTH calls. First prompt: "Use select_tools and execute bash exactly ${JSON.stringify(command)} (timeout=180000), then report the exact output." Second prompt: "After your current task completes, reply with exactly ${marker}." Invoke both calls now; do not wait for one to finish before making the other. Do not create a new subagent or use any other tool. After two receipts, briefly say you are waiting; runtime delivers results automatically.`,
        { sessionId: setup.prompt.sessionId, clientRequestId: randomUUID() },
      );
      await until(
        async () => {
          const records = await store.list({
            parentSessionId: receipt.sessionId,
          });
          return records.length >= 3;
        },
        "two repeat delegations accepted",
        90000,
      );
      const [setupRecord, first, queued] = [
        ...(await store.list({
          parentSessionId: receipt.sessionId,
          ascending: true,
        })),
      ].sort(
        (a, b) => (a.delegationSequence ?? 0) - (b.delegationSequence ?? 0),
      );
      expect(first).toBeDefined();
      expect(queued).toBeDefined();
      expect(first.subagentId).toBe(queued.subagentId);
      expect(first.executionId).not.toBe(queued.executionId);
      expect(first.childUserMessageId).not.toBe(queued.childUserMessageId);
      expect(setupRecord.executionId).toBe(seed.executionId);
      expect([first.delegationSequence, queued.delegationSequence]).toEqual([
        2, 3,
      ]);
      await until(async () => {
        try {
          await readFile(join(fixture, "started"));
          return true;
        } catch {
          return false;
        }
      }, "real first child bash started");
      const atQueue = [
        ...(await store.list({
          parentSessionId: receipt.sessionId,
          ascending: true,
        })),
      ].sort(
        (a, b) => (a.delegationSequence ?? 0) - (b.delegationSequence ?? 0),
      );
      expect(atQueue[1].status).toBe("running");
      expect(atQueue[2].status).toBe("queued");
      expect(atQueue[1].childSessionId).toBeDefined();
      const childSessionId = atQueue[1].childSessionId!;
      const parentToolCalls = parts().filter(
        (part) =>
          part.tool === "subagent_run" && part.sessionId === receipt.sessionId,
      );
      for (const execution of [first, queued])
        expect(
          parentToolCalls.some((part) => part.callId === execution.requestId),
        ).toBe(true);

      const query = {
        rootSessionId: receipt.sessionId,
        subagentId: first.subagentId,
      };
      const queuedView = await backend.getSubagentConversationView({
        ...query,
        anchorExecutionId: queued.executionId,
      });
      expect(queuedView.anchorFound).toBe(true);
      expect(queuedView.anchorMessageId).toBe(queued.childUserMessageId);
      expect(queuedView.messages.map((message) => message.id)).toContain(
        queued.childUserMessageId,
      );
      expect(JSON.stringify(queuedView.messages)).toContain(marker);
      expect(queuedView.executions.map((item) => item.executionId)).toEqual(
        expect.arrayContaining([first.executionId, queued.executionId]),
      );
      expect(
        messages(childSessionId).some(
          (message) => message.id === queued.childUserMessageId,
        ),
      ).toBe(false);
      expect(
        providerUserBodies.some(
          (body) =>
            body.sessionId === childSessionId && body.text.includes(marker),
        ),
      ).toBe(false);

      await writeFile(releasePath, "go");
      phase = "final-completion";
      const completion = await backend.waitForPrompt(receipt.promptId, {
        signal: AbortSignal.timeout(300000),
      });
      expect(completion.prompt.status).toBe("succeeded");
      await until(
        async () =>
          (await store.list({ parentSessionId: receipt.sessionId })).every(
            (record) => record.status === "completed",
          ),
        "both child executions completed",
      );
      const finalRecords = await store.list({
        parentSessionId: receipt.sessionId,
        ascending: true,
      });
      expect(finalRecords).toHaveLength(3);
      expect(finalRecords[2].childUserMessageId).toBe(
        queued.childUserMessageId,
      );
      expect(finalRecords[2].childSessionId).toBe(childSessionId);
      expect(
        messages(childSessionId).filter(
          (message) => message.id === queued.childUserMessageId,
        ),
      ).toHaveLength(1);
      expect(textFor(queued.childUserMessageId!)).toContain(marker);
      expect(
        providerUserBodies.some(
          (body) =>
            body.sessionId === childSessionId && body.text.includes(marker),
        ),
      ).toBe(true);
      const finalView = await backend.getSubagentConversationView(query);
      expect(finalView.messages.map((message) => message.id)).toContain(
        first.childUserMessageId,
      );
      expect(finalView.messages.map((message) => message.id)).toContain(
        queued.childUserMessageId,
      );
      expect(JSON.stringify(finalView.messages)).toContain(
        "FIRST_SEGMENT_COMPLETE_7261",
      );
      expect(JSON.stringify(finalView.messages)).toContain(marker);
      expect(permissionErrors).toEqual([]);
      expect(session.providerRequests.length).toBeLessThanOrEqual(15);
      phase = "passed";
    } catch (error) {
      failure = error;
      const failureMessage = error instanceof Error ? error.message : "";
      const rawCauseCode =
        error instanceof Error &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "code" in error.cause
          ? error.cause.code
          : undefined;
      diagnosis = {
        phase,
        errorCode: failureMessage.includes("Request timed out.")
          ? "PROVIDER_REQUEST_TIMEOUT"
          : failureMessage === "Missing ZenMux credential"
            ? "MISSING_ZENMUX_CREDENTIAL"
            : failureMessage.startsWith("Timed out:")
              ? "TEST_WAIT_TIMEOUT"
              : "UNCLASSIFIED_FAILURE",
        errorName: error instanceof Error ? error.name : undefined,
        causeCode:
          typeof rawCauseCode === "string" &&
          /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(rawCauseCode)
            ? rawCauseCode
            : undefined,
        providerRequests: session?.providerRequests.length ?? 0,
        requestStates: session?.providerRequests.map((request) => ({
          purpose: request.purpose,
          settled: request.settled,
          exhausted: request.exhausted,
        })),
        permissionErrors,
      };
      if (session && rootSessionId) {
        const records = await new DatabaseSubagentExecutionStore().list({
          parentSessionId: rootSessionId,
        });
        diagnosis = {
          ...diagnosis,
          rootSessionId,
          executions: records.map((record) => ({
            executionId: record.executionId,
            subagentId: record.subagentId,
            status: record.status,
            childRunId: record.childRunId,
          })),
          parentTools: parts()
            .filter((part) => part.sessionId === rootSessionId)
            .map((part) => ({
              tool: part.tool,
              callId: part.callId,
              state: part.state.status,
            })),
        };
        console.error(
          "Real conversation diagnostic:",
          JSON.stringify(diagnosis),
        );
      }
      sessionRoot ??= getFormalSetupFailureEvidence(error)?.diagnosticWorkspace;
    } finally {
      if (releasePath)
        await writeFile(releasePath, "go").catch(() => undefined);
      const cleanupErrors = await collectFormalCleanupErrors([
        { code: "UNSUBSCRIBE_FAILED", run: unsubscribe },
        {
          code: "PERMISSION_DRAIN_FAILED",
          run: async (): Promise<void> => {
            await Promise.allSettled([...pendingPermissions]);
          },
        },
        {
          code: "SESSION_CLOSE_FAILED",
          run: (): Promise<void> => session?.close() ?? Promise.resolve(),
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
          code: "SESSION_REMOVE_FAILED",
          run: (): Promise<void> =>
            sessionRoot
              ? rm(sessionRoot, { recursive: true, force: true })
              : Promise.resolve(),
        },
        {
          code: "ISOLATED_DIRECTORY_REMOVE_FAILED",
          run: (): Promise<void> =>
            rm(isolated, { recursive: true, force: true }),
        },
      ]);
      if (cleanupErrors.length && !failure)
        failure = new Error(JSON.stringify(cleanupErrors));
      try {
        const evidenceDir = join(
          process.cwd(),
          ".ohbaby/test-evidence/improve-3.1",
        );
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(
          join(evidenceDir, "real-same-child-conversation.json"),
          JSON.stringify(
            {
              passed: failure === undefined,
              profileId,
              phase,
              diagnosis,
              providerRequests: session?.providerRequests.length ?? 0,
              requestStates: session?.providerRequests.map((request) => ({
                purpose: request.purpose,
                settled: request.settled,
                exhausted: request.exhausted,
              })),
              cleanupErrors,
            },
            null,
            2,
          ),
        );
      } catch {
        failure ??= new Error("EVIDENCE_WRITE_FAILED");
      }
    }
    if (failure) throw failure;
  },
);
