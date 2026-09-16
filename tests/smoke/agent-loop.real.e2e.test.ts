import { observeAssembly, fingerprint } from "./agent-loop-assembly.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { retainFailedLoopWorkspace } from "./agent-loop-workspace.js";
import { Lifecycle } from "../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import { createFormalCacheSession } from "./formal-cache-session.js";
import {
  LIVE_CONTEXT_PROFILES,
  createCompactionNotes,
} from "./formal-cache-live-context.js";
import {
  hash,
  historySelectionEvidence,
  LOOP_NOTICES,
  observeClient,
  observeEvent,
  publicAudit,
  toolHandoffChecks,
  type LoopAudit,
  type LoopMode,
  type LoopWire,
} from "./agent-loop-observer.js";

const audit = vi.hoisted(
  (): LoopAudit => ({
    mode: (process.env.OHBABY_REAL_AGENT_LOOP_MODE ?? "stage-a") as LoopMode,
    requests: [],
    prepared: [],
    events: [],
    results: [],
    injected: false,
  }),
);
vi.mock(
  "../../packages/ohbaby-agent/src/core/llm-client/index.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../packages/ohbaby-agent/src/core/llm-client/index.js")
      >();
    return {
      ...original,
      createLLMClient: async (
        ...args: Parameters<typeof original.createLLMClient>
      ) => {
        const client = await original.createLLMClient(...args);
        observeClient(client, audit);
        return client;
      },
    };
  },
);

vi.mock(
  "../../packages/ohbaby-agent/src/core/context/index.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../packages/ohbaby-agent/src/core/context/index.js")
      >();
    return {
      ...original,
      createContextManager: (
        options: Parameters<typeof original.createContextManager>[0],
      ) =>
        observeAssembly(
          original.createContextManager,
          options,
          (audit.prepared ??= []),
        ),
    };
  },
);

import {
  savedFailure,
  interruptionCarriers,
  persistedToolProof,
} from "./agent-loop-state.js";
const notices = LOOP_NOTICES;

function verifyPairing(wire: LoopWire): void {
  expect(
    wire.results.every((id) => id.length > 0 && wire.calls.includes(id)),
  ).toBe(true);
  expect(new Set(wire.calls).size).toBe(wire.calls.length);
  expect(new Set(wire.results).size).toBe(wire.results.length);
}

const enabled = process.env.OHBABY_RUN_REAL_AGENT_LOOP === "1";
describe.runIf(enabled)("real production agent loop", () => {
  it("runs the explicitly selected fixed profile and boundary", async () => {
    const profile = LIVE_CONTEXT_PROFILES.find(
      (item) => item.id === process.env.OHBABY_REAL_AGENT_LOOP_PROFILE,
    );
    if (!profile) throw new Error("SELECT_FIXED_AGENT_LOOP_PROFILE");
    if (
      ![
        "stage-a",
        "e1",
        "length",
        "length-terminal",
        "transport",
        "cancel",
        "tool-cancel",
        "compaction",
      ].includes(audit.mode)
    )
      throw new Error("SELECT_AGENT_LOOP_MODE");
    if (
      (audit.mode === "length" || audit.mode === "length-terminal") &&
      profile.protocol !== "openai-responses"
    )
      throw new Error("LENGTH_REQUIRES_RESPONSES");
    const maxRequests = Number(
      process.env.OHBABY_REAL_AGENT_LOOP_MAX_HTTP ?? "20",
    );
    if (
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > 20
    )
      throw new Error("INVALID_AGENT_LOOP_HTTP_BUDGET");
    const dir =
      process.env.OHBABY_REAL_AGENT_LOOP_EVIDENCE_DIR ??
      ".ohbaby/test-evidence/improve-7/live-loop";
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${profile.id}-${audit.mode}-${String(Date.now())}`);
    const version = {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      workingTree: execFileSync("git", ["status", "--short"], {
        encoding: "utf8",
      })
        .trim()
        .split("\n"),
    };
    let session:
      | Awaited<ReturnType<typeof createFormalCacheSession>>
      | undefined;
    const isLength =
      audit.mode === "length" || audit.mode === "length-terminal";
    let phase = "setup";
    let failure: { phase: string; code: string } | undefined;
    let failureHistory:
      | Omit<ReturnType<typeof savedFailure>, "text">
      | undefined;
    const projectionChecks: unknown[] = [];
    const persistenceChecks: unknown[] = [];
    let cancelAfterTool = audit.mode === "tool-cancel";
    let toolCancelProof: ReturnType<typeof persistedToolProof>;
    let compactionCarrierIds: string[] = [];
    const compactionChecks: unknown[] = [];
    let restoreRead: (() => Promise<void>) | undefined;
    // The wrapper below explicitly restores the original receiver with apply(this).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRun = Lifecycle.prototype.run;
    const spy = vi
      .spyOn(Lifecycle.prototype, "run")
      .mockImplementation(async function* (
        this: Lifecycle,
        ...args: Parameters<Lifecycle["run"]>
      ) {
        const iterator = originalRun.apply(this, args);
        const acceptedUsage: { inputTokens: number; outputTokens: number }[] =
          [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            const result = next.value;
            if (result.usage?.usageComplete) {
              expect(result.usage.inputTokens).toBe(
                acceptedUsage.reduce((sum, item) => sum + item.inputTokens, 0),
              );
              expect(result.usage.outputTokens).toBe(
                acceptedUsage.reduce((sum, item) => sum + item.outputTokens, 0),
              );
            }
            audit.results.push({
              success: result.success,
              finishReason: result.finishReason,
              terminalReason: result.terminalReason,
              usage: result.usage,
            });
            return result;
          }
          if (next.value.type === "llm:complete" && next.value.tokenUsage)
            acceptedUsage.push(next.value.tokenUsage);
          audit.events.push(observeEvent(next.value));
          if (next.value.type === "tool:start") {
            const saved = persistedToolProof(
              next.value.sessionId,
              next.value.callId,
            );
            expect(saved?.status).toBe("running");
            expect(saved?.assistantError).toBeNull();
            expect(["tool_calls", "stop"]).toContain(saved?.acceptedFinish);
            const modelRequest = audit.requests.findLast(
              (row) => row.purpose === "agent-step",
            );
            if (modelRequest?.nativeOutputObserved)
              expect(saved?.nativeCount).toBeGreaterThan(0);
            expect(saved?.inputHash).toBe(fingerprint(next.value.params));
            persistenceChecks.push({ event: "tool:start", ...saved });
          }
          if (next.value.type === "tool:result") {
            const saved = persistedToolProof(
              next.value.sessionId,
              next.value.callId,
            );
            expect(saved?.status).toBe(
              next.value.result.status === "success"
                ? "completed"
                : next.value.result.status === "cancelled"
                  ? "aborted"
                  : "error",
            );
            if (next.value.result.status === "success") {
              expect(saved?.outputHash).toBe(
                hash(next.value.result.output ?? ""),
              );
            }
            persistenceChecks.push({
              event: "tool:result",
              outputMatchesEvent:
                next.value.result.status === "success"
                  ? saved?.outputHash === hash(next.value.result.output ?? "")
                  : undefined,
              ...saved,
            });
          }
          if (
            next.value.type === "tool:result" &&
            next.value.result.status !== "success" &&
            restoreRead
          ) {
            await restoreRead();
            restoreRead = undefined;
          }
          if (
            cancelAfterTool &&
            next.value.type === "tool:result" &&
            next.value.result.status === "success"
          ) {
            // Lifecycle yields tool:result only after updateToolPart has completed.
            // Pause here; inspect SQLite before requesting cancellation, without a timing guess.
            toolCancelProof = persistedToolProof(
              next.value.sessionId,
              next.value.callId,
            );
            expect(toolCancelProof?.status).toBe("completed");
            expect(toolCancelProof?.outputCharacters).toBeGreaterThan(0);
            expect(toolCancelProof?.assistantError).toBeNull();
            cancelAfterTool = false;
            audit.injected = true;
            await audit.onCancel?.();
          }
          yield next.value;
        }
      });
    try {
      session = await createFormalCacheSession(profile.id, {
        requireDetectedWindow: true,
        maxRequests,
      });
      const current = session;
      audit.onCancel = async () => {
        const snapshot = await current.backend.getSnapshot();
        const run = snapshot.runs.findLast(
          (item) => item.status.kind === "running",
        );
        if (!run) throw new Error("NO_ACTIVE_RUN_TO_CANCEL");
        await current.backend.abortRun(run.id);
      };
      const firstPrompt = [
        "stage-a",
        "e1",
        "compaction",
        "tool-cancel",
      ].includes(audit.mode)
        ? `Use the read tool on exactly ${session.readFilePath}. ${audit.mode === "stage-a" ? "Read once." : "After the first result, call read again on the same file to verify it. Two sequential reads are required."} Report Project, Release and Owner. Do not use other tools or change files.` +
          (audit.mode === "compaction" ? createCompactionNotes(30) : "")
        : isLength
          ? "Do not use tools. Write a numbered list of 300 practical gardening tips with at least 15 words each. Start immediately and do not shorten the list."
          : "Do not use tools. Start your answer with CEDAR_STREAM_7 and explain rainfall formation in ten detailed sentences.";
      phase = "initial-run";
      const first = await session.submit(firstPrompt);
      if (["stage-a", "e1", "compaction"].includes(audit.mode)) {
        expect(first.result.prompt.status).toBe("succeeded");
        expect(
          first.checkpoint.persisted.completedTools.length,
        ).toBeGreaterThanOrEqual(audit.mode === "stage-a" ? 1 : 2);
        expect(
          first.checkpoint.answer.project &&
            first.checkpoint.answer.owner &&
            first.checkpoint.answer.release,
        ).toBe(true);
        expect(
          first.checkpoint.persisted.completedTools.every(
            (tool) => tool.allowed,
          ),
        ).toBe(true);
      } else if (audit.mode === "tool-cancel") {
        expect(first.result.prompt.status).toBe("cancelled");
        expect(audit.results.at(-1)?.terminalReason).toBe("cancelled");
        expect(
          audit.requests.filter((row) => row.purpose === "agent-step"),
        ).toHaveLength(1);
        expect(
          audit.events.filter((event) => event.type === "llm:complete"),
        ).toHaveLength(1);
        expect(
          audit.events.filter((event) => event.type === "tool:result"),
        ).toHaveLength(1);
        expect(
          audit.events.find((event) => event.type === "tool:result")?.toolName,
        ).toBe("read");
        expect(first.checkpoint.persisted.completedTools).toHaveLength(1);
        expect(first.checkpoint.persisted.completedTools[0]?.allowed).toBe(
          true,
        );
        expect(cancelAfterTool).toBe(false);
        expect(toolCancelProof).toBeDefined();
        expect(
          interruptionCarriers(first.result.prompt.sessionId).filter(
            (row) => row.kind === "lifecycle-interruption" && !row.retired,
          ),
        ).toHaveLength(1);
      } else {
        expect(first.result.prompt.status).toBe(
          audit.mode === "cancel" ? "cancelled" : "failed",
        );
        expect(audit.results.at(-1)?.terminalReason).toBe(
          isLength
            ? "output_length"
            : audit.mode === "cancel"
              ? "cancelled"
              : "provider_stream_interrupted",
        );
        expect(
          audit.requests.filter((row) => row.purpose === "agent-step"),
        ).toHaveLength(1);
        expect(
          audit.events.filter((event) => event.type === "llm:retrying"),
        ).toHaveLength(0);
        if (audit.mode === "transport" || audit.mode === "cancel") {
          expect(audit.injected).toBe(true);
          expect(audit.faults).toHaveLength(1);
          expect(audit.faults?.[0]?.kind).toBe(audit.mode);
          expect(audit.faults?.[0]?.visibleCharacters).toBeGreaterThanOrEqual(
            64,
          );
        }
        const saved = savedFailure(first.result.prompt.sessionId);
        const { text: _text, ...safe } = saved;
        failureHistory = safe;
        expect(saved.text.length).toBeGreaterThan(0);
        expect(saved.nativeCount).toBe(0);
        if (isLength) {
          const initial = audit.requests.find(
            (row) => row.purpose === "agent-step",
          );
          expect(initial?.exhausted).toBe(true);
          expect(initial?.finishes).toContain("length");
          expect(initial?.http[0]?.maxOutputTokens).toBe(128);
          expect(
            audit.events.filter((event) => event.type === "llm:complete"),
          ).toHaveLength(1);
          expect(
            audit.events.filter((event) => event.type === "tool:start"),
          ).toHaveLength(0);
          expect(first.checkpoint.persisted.usageParts.length).toBeGreaterThan(
            0,
          );
        }
        if (audit.mode !== "length-terminal") {
          const mode = audit.mode as keyof typeof notices;
          const checkProjection = (): void => {
            const wire = audit.requests
              .filter((row) => row.purpose === "agent-step")
              .at(-1)
              ?.http.at(-1);
            expect(Boolean(wire)).toBe(true);
            if (!wire) return;
            const markerCount =
              wire.assistantText.split(notices[mode]).length - 1;
            const carriesSavedBody = wire.assistantText.includes(saved.text);
            const hasPlaceholder = wire.text.includes("(Interrupted)");
            projectionChecks.push({
              phase,
              markerCount,
              carriesSavedBody,
              hasPlaceholder,
              textHash: wire.textHash,
              roles: wire.roles,
              nativeTypes: wire.nativeTypes,
            });
            expect(markerCount).toBe(1);
            expect(hasPlaceholder).toBe(false);
            if (mode !== "cancel") expect(carriesSavedBody).toBe(true);
            else expect(carriesSavedBody).toBe(false);
            expect(wire.roles).toContain("assistant");
            verifyPairing(wire);
          };
          phase = "continuation";
          const next = await session.submit(
            "Do not use tools. Acknowledge the prior incomplete response in one short sentence.",
          );
          expect(next.result.prompt.status).toBe("succeeded");
          checkProjection();
          phase = "reopen";
          await session.reopen();
          phase = "post-reopen";
          const reopened = await session.submit(
            "Do not use tools. Acknowledge the conversation in one short sentence.",
          );
          expect(reopened.result.prompt.status).toBe("succeeded");
          checkProjection();
        } else
          projectionChecks.push({
            status: "not-run",
            reason:
              "Stage B terminal-only; Stage C history assertions remain in length mode",
          });
      }
      if (audit.mode === "e1") {
        phase = "business-failure";
        const fixture = await readFile(session.readFilePath, "utf8");
        await rm(session.readFilePath);
        restoreRead = () => writeFile(current.readFilePath, fixture);
        const recovered = await session.submit(
          `Use read on exactly ${session.readFilePath}. If it fails, retry read once on exactly the same path, because this fixture becomes available after the first failure. Then report Project and Owner. Do not use other tools.`,
        );
        expect(recovered.result.prompt.status).toBe("succeeded");
        expect(
          audit.events.some(
            (event) => event.type === "tool:result" && event.success === false,
          ),
        ).toBe(true);
        expect(
          recovered.checkpoint.answer.project &&
            recovered.checkpoint.answer.owner,
        ).toBe(true);
        expect(restoreRead).toBeUndefined();
      }
      if (audit.mode === "compaction") {
        phase = "compaction-stream-fixture";
        audit.pendingFault = "transport";
        const interrupted = await session.submit(
          "Do not use tools. Start with CEDAR_STREAM_7 and explain rainfall formation in ten detailed sentences.",
        );
        expect(interrupted.result.prompt.status).toBe("failed");
        expect(audit.results.at(-1)?.terminalReason).toBe(
          "provider_stream_interrupted",
        );
        const streamBody = savedFailure(
          interrupted.result.prompt.sessionId,
          "MessageStreamInterruptedError",
        );
        expect(streamBody.text.length).toBeGreaterThanOrEqual(64);
        expect(streamBody.nativeCount).toBe(0);
        phase = "compaction-cancel-fixture";
        audit.pendingFault = "cancel";
        const cancelled = await session.submit(
          "Do not use tools. Start with CEDAR_CANCEL_7 and explain photosynthesis in ten detailed sentences.",
        );
        expect(cancelled.result.prompt.status).toBe("cancelled");
        const cancelledBody = savedFailure(
          cancelled.result.prompt.sessionId,
          "MessageAbortedError",
        );
        expect(cancelledBody.text.length).toBeGreaterThanOrEqual(64);
        expect(cancelledBody.factCount).toBe(1);
        expect(cancelledBody.nativeCount).toBe(0);
        expect(audit.faults?.map((fault) => fault.kind)).toEqual([
          "transport",
          "cancel",
        ]);
        compactionCarrierIds = [
          ...streamBody.textPartIds,
          ...cancelledBody.textPartIds,
          ...cancelledBody.factPartIds,
        ];
        expect(compactionCarrierIds.length).toBeGreaterThanOrEqual(3);
        compactionChecks.push({
          phase,
          streamBodyHash: streamBody.textHashes,
          cancelledBodyHash: cancelledBody.textHashes,
          carrierIds: compactionCarrierIds,
        });
        phase = "pre-compaction";
        await session.submit(
          "Repeat Project Cedar, Release 17, Owner Lin. Do not use tools." +
            createCompactionNotes(60),
        );
        await session.submit(
          "Keep Project Cedar, Release 17, Owner Lin for later. Do not use tools.",
        );
        const before = session.nativeStateHashes("before-compaction");
        const ordinaryWire = audit.requests
          .filter((row) => row.purpose === "agent-step")
          .at(-1)
          ?.http.at(-1);
        expect(ordinaryWire).toBeDefined();
        if (!ordinaryWire) throw new Error("MISSING_PRE_COMPACTION_HTTP");
        const ordinarySelection = historySelectionEvidence(ordinaryWire, {
          channel: "assistant",
          allowedBody: streamBody.text,
          excludedBody: cancelledBody.text,
        });
        compactionChecks.push({ phase, selection: ordinarySelection });
        expect(ordinarySelection.allowedBodyPresent).toBe(true);
        expect(ordinarySelection.excludedBodyPresent).toBe(false);
        expect(ordinarySelection.transportNotices).toBe(1);
        expect(ordinarySelection.cancelNotices).toBe(1);
        expect(
          interruptionCarriers(cancelled.result.prompt.sessionId)
            .filter((row) => compactionCarrierIds.includes(row.id))
            .every((row) => !row.retired),
        ).toBe(true);
        phase = "compaction";
        const compacted = await session.compact();
        expect(compacted.result.status).toBe("compacted");
        expect(
          compacted.checkpoint.persisted.context.summaryParts,
        ).toBeGreaterThan(0);
        expect(
          compacted.checkpoint.persisted.context.retiredParts,
        ).toBeGreaterThan(0);
        const after = session.nativeStateHashes("after-compaction");
        const summaryRequests = audit.requests.filter(
          (row) => row.purpose === "context-summary",
        );
        expect(summaryRequests.length).toBeGreaterThan(0);
        for (const request of summaryRequests) {
          expect(request.nativeCount).toBe(0);
          expect(request.http.length).toBeGreaterThan(0);
          for (const wire of request.http) {
            const selected = historySelectionEvidence(wire, {
              channel: "summary",
              allowedBody: streamBody.text,
              excludedBody: cancelledBody.text,
            });
            compactionChecks.push({
              phase,
              requestSequence: request.sequence,
              selection: selected,
            });
            expect(selected.allowedBodyPresent).toBe(true);
            expect(selected.excludedBodyPresent).toBe(false);
            expect(selected.transportNotices).toBe(1);
            expect(selected.cancelNotices).toBe(1);
            expect(selected.hasPlaceholder).toBe(false);
            expect(wire.nativeTypes).toEqual([]);
            expect(wire.text.includes("read")).toBe(true);
            expect(wire.text.includes("file_path")).toBe(true);
            expect(
              wire.text.includes("Cedar") && wire.text.includes("Lin"),
            ).toBe(true);
          }
        }
        const carriers = interruptionCarriers(
          cancelled.result.prompt.sessionId,
        ).filter((row) => compactionCarrierIds.includes(row.id));
        expect(carriers).toHaveLength(compactionCarrierIds.length);
        expect(carriers.every((row) => row.retired)).toBe(true);
        compactionChecks.push({ phase: "after-compaction", carriers });
        expect(
          after.retired.some((value) => before.active.includes(value)),
        ).toBe(true);
        expect(
          audit.requests.some(
            (row) =>
              row.purpose === "context-summary" &&
              row.exhausted &&
              row.finishes.includes("stop") &&
              row.outputCharacters > 0,
          ),
        ).toBe(true);
      }
      if (
        audit.mode === "e1" ||
        audit.mode === "compaction" ||
        audit.mode === "tool-cancel"
      ) {
        const checkRetainedFacts = async (): Promise<void> => {
          const wire = audit.requests
            .filter((row) => row.purpose === "agent-step")
            .at(-1)
            ?.http.at(-1);
          expect(wire).toBeDefined();
          if (!wire) throw new Error("MISSING_RETAINED_FACTS_HTTP");
          const selected = historySelectionEvidence(wire, {
            channel: "assistant",
          });
          const sessionId = (await current.status()).sessionId;
          if (audit.mode === "tool-cancel") {
            expect(selected.cancelNotices).toBe(1);
            expect(selected.hasPlaceholder).toBe(false);
            expect(wire.calls).toContain(toolCancelProof?.callId);
            expect(wire.results).toContain(toolCancelProof?.callId);
            expect(
              persistedToolProof(sessionId, toolCancelProof?.callId ?? ""),
            ).toEqual(toolCancelProof);
            projectionChecks.push({
              phase,
              selection: selected,
              tool: toolCancelProof,
            });
          }
          if (audit.mode === "compaction") {
            expect(selected.cancelNotices).toBe(0);
            expect(selected.transportNotices).toBe(0);
            expect(selected.hasPlaceholder).toBe(false);
            const carriers = interruptionCarriers(sessionId).filter((row) =>
              compactionCarrierIds.includes(row.id),
            );
            expect(carriers).toHaveLength(compactionCarrierIds.length);
            expect(carriers.every((row) => row.retired)).toBe(true);
            compactionChecks.push({ phase, selection: selected, carriers });
          }
          verifyPairing(wire);
        };
        const toolIds = session.allToolPartIds();
        phase = "continuation";
        const continued = await session.submit(
          "Without tools, confirm Project Cedar and its Owner from the prior conversation.",
        );
        expect(continued.result.prompt.status).toBe("succeeded");
        await checkRetainedFacts();
        const before = session.nativeStateHashes("before-reopen");
        phase = "reopen";
        await session.reopen();
        expect(session.nativeStateHashes("after-reopen")).toEqual(before);
        phase = "post-reopen";
        const reopened = await session.submit(
          "Without tools, confirm the Project and Owner again.",
        );
        expect(reopened.result.prompt.status).toBe("succeeded");
        await checkRetainedFacts();
        expect(
          reopened.checkpoint.answer.project &&
            reopened.checkpoint.answer.owner,
        ).toBe(true);
        expect(session.allToolPartIds()).toEqual(toolIds);
      }
      phase = "final-invariants";
      const agentRequests = audit.requests.filter(
        (row) => row.purpose === "agent-step",
      );
      expect(agentRequests.length).toBeGreaterThan(0);
      for (const request of agentRequests) {
        expect(request.assembly?.matchesPrepared).toBe(true);
        const prepared = audit.prepared?.find(
          (item) => item.sequence === request.assembly?.preparedSequence,
        );
        expect(prepared?.measuredSamePayload).toBe(true);
        expect(prepared?.frozen).toBe(true);
        for (const wire of request.http) {
          expect(wire.tools).toEqual(request.assembly?.shape.tools);
          expect(wire.callPayloads).toEqual(request.assembly?.shape.calls);
          expect(wire.resultPayloads).toEqual(request.assembly?.shape.results);
          expect(wire.opaque).toEqual(request.assembly?.shape.opaque);
        }
      }
      expect(
        audit.requests
          .filter((row) => row.purpose === "agent-step")
          .every((row) => row.http.length > 0),
      ).toBe(true);
      if (["stage-a", "e1", "compaction", "tool-cancel"].includes(audit.mode)) {
        const handoffs = toolHandoffChecks(audit);
        expect(handoffs.agentStepWireCount).toBeGreaterThan(1);
        expect(handoffs.startedCalls).toBeGreaterThan(0);
        expect(
          handoffs.allExecuted &&
            handoffs.allReplayed &&
            handoffs.allResultsPaired,
        ).toBe(true);
        if (audit.mode === "stage-a")
          expect(
            audit.events
              .filter((event) => event.type === "tool:result")
              .every((event) => event.success === true),
          ).toBe(true);
      }
      for (const request of audit.requests)
        for (const wire of request.http) verifyPairing(wire);
      if (audit.mode !== "stage-a") {
        const accepted = audit.requests.filter(
          (row) =>
            row.purpose === "agent-step" &&
            row.exhausted &&
            row.finishes.length > 0,
        ).length;
        expect(
          audit.events.filter((event) => event.type === "llm:complete"),
        ).toHaveLength(accepted);
      }
      expect(session.wire.length).toBeLessThanOrEqual(maxRequests);
      expect(session.permissionErrors).toEqual([]);
      expect(session.providerRequests.every((row) => row.settled)).toBe(true);
      expect(session.contextWindow.source).toBe("detected");
    } catch (error) {
      failure = {
        phase,
        code:
          error instanceof Error && error.name === "AssertionError"
            ? "ASSERTION_FAILED"
            : "LIVE_RUN_FAILED",
      };
      throw new Error(
        `${failure.code} at ${phase}; sanitized evidence ${path}-audit.json`,
      );
    } finally {
      try {
        if (session) await session.save(`${path}-session.json`);
        await writeFile(
          `${path}-audit.json`,
          JSON.stringify(
            {
              profile: profile.id,
              version,
              mode: audit.mode,
              maxRequests,
              injection: [
                "transport",
                "cancel",
                "tool-cancel",
                "compaction",
              ].includes(audit.mode)
                ? "real upstream stream plus local fault/cancellation"
                : isLength
                  ? "real provider length terminal; test max output 128"
                  : undefined,
              ...(publicAudit(audit) as object),
              failureHistory,
              retainedWorkspace:
                failure && session
                  ? { root: session.root, manifestPath: `${path}-resume.json` }
                  : undefined,
              projectionChecks,
              persistenceChecks,
              compactionChecks,
              toolCancelProof,
              failure,
            },
            null,
            2,
          ) + "\n",
        );
        process.stdout.write(
          JSON.stringify({
            profile: profile.id,
            mode: audit.mode,
            evidence: `${path}-audit.json`,
            failure,
          }) + "\n",
        );
      } finally {
        spy.mockRestore();
        if (session) {
          await session.close();
          if (failure) {
            const lastCheckpoint = session.checkpoints.findLast(
              (item) => "cache" in item,
            );
            await retainFailedLoopWorkspace({
              root: session.root,
              manifestPath: `${path}-resume.json`,
              auditPath: `${path}-audit.json`,
              profile: profile.id,
              ...(lastCheckpoint && "cache" in lastCheckpoint
                ? { sessionId: lastCheckpoint.cache.sessionId }
                : {}),
              httpRequests: session.wire.length,
              commit: version.commit,
            });
          } else await rm(session.root, { recursive: true, force: true });
        }
      }
    }
  });
});
