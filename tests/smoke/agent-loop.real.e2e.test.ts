import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { Lifecycle } from "../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { createFormalCacheSession } from "./formal-cache-session.js";
import {
  LIVE_CONTEXT_PROFILES,
  createCompactionNotes,
} from "./formal-cache-live-context.js";
import {
  hash,
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

const notices = {
  length: "[Response incomplete: output limit reached.]",
  transport: "[Response interrupted: the saved text below may be incomplete.]",
  cancel: "[Response cancelled by the user.]",
} as const;

function verifyPairing(wire: LoopWire): void {
  expect(
    wire.results.every((id) => id.length > 0 && wire.calls.includes(id)),
  ).toBe(true);
  expect(new Set(wire.calls).size).toBe(wire.calls.length);
  expect(new Set(wire.results).size).toBe(wire.results.length);
}

function savedFailure(sessionId: string): {
  text: string;
  errors: string[];
  nativeCount: number;
  textHashes: string[];
  factCount: number;
} {
  const rows = getDatabase()
    .prepare<{
      text: string | null;
      type: string;
      error: string | null;
      synthetic: number | null;
      ignored: number | null;
      kind: string | null;
    }>(
      `SELECT json_extract(p.data, '$.text') AS text, p.type,
      json_extract(m.data, '$.error.name') AS error,
      json_extract(p.data, '$.synthetic') AS synthetic,
      json_extract(p.data, '$.ignored') AS ignored,
      json_extract(p.data, '$.metadata.kind') AS kind
     FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = ? AND m.context_scope_id IS NULL AND m.role = 'assistant'
       AND json_extract(m.data, '$.error') IS NOT NULL
       AND json_extract(p.data, '$.time.compacted') IS NULL
     ORDER BY p.created_at, p.order_index`,
    )
    .all(sessionId);
  const texts = rows
    .filter(
      (row) =>
        row.type === "text" &&
        row.text &&
        !row.synthetic &&
        !row.ignored &&
        row.kind !== "lifecycle-interruption" &&
        row.kind !== "model-context-runtime",
    )
    .map((row) => row.text ?? "");
  return {
    text: texts.join(""),
    errors: [...new Set(rows.map((row) => row.error ?? "unknown"))],
    nativeCount: rows.filter((row) => row.type === "model-state").length,
    textHashes: texts.map(hash),
    factCount: rows.filter(
      (row) => row.type === "text" && row.kind === "lifecycle-interruption",
    ).length,
  };
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
        "compaction",
      ].includes(audit.mode)
    )
      throw new Error("SELECT_AGENT_LOOP_MODE");
    if (
      (audit.mode === "length" || audit.mode === "length-terminal") &&
      profile.protocol !== "openai-responses"
    )
      throw new Error("LENGTH_REQUIRES_RESPONSES");
    const dir =
      process.env.OHBABY_REAL_AGENT_LOOP_EVIDENCE_DIR ??
      ".ohbaby/test-evidence/improve-7/live-loop";
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${profile.id}-${audit.mode}-${Date.now()}`);
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
    let restoreRead: (() => Promise<void>) | undefined;
    const originalRun = Lifecycle.prototype.run;
    const spy = vi
      .spyOn(Lifecycle.prototype, "run")
      .mockImplementation(async function* (
        this: Lifecycle,
        ...args: Parameters<Lifecycle["run"]>
      ) {
        const iterator = originalRun.apply(this, args);
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            const result = next.value;
            audit.results.push({
              success: result.success,
              finishReason: result.finishReason,
              terminalReason: result.terminalReason,
              usage: result.usage,
            });
            return result;
          }
          audit.events.push(observeEvent(next.value));
          if (
            next.value.type === "tool:result" &&
            next.value.result.status !== "success" &&
            restoreRead
          ) {
            await restoreRead();
            restoreRead = undefined;
          }
          yield next.value;
        }
      });
    try {
      session = await createFormalCacheSession(profile.id, {
        requireDetectedWindow: true,
        maxRequests: 20,
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
      const firstPrompt = ["stage-a", "e1", "compaction"].includes(audit.mode)
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
        phase = "pre-compaction";
        await session.submit(
          "Repeat Project Cedar, Release 17, Owner Lin. Do not use tools." +
            createCompactionNotes(60),
        );
        await session.submit(
          "Keep Project Cedar, Release 17, Owner Lin for later. Do not use tools.",
        );
        const before = session.nativeStateHashes("before-compaction");
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
      if (audit.mode === "e1" || audit.mode === "compaction") {
        const toolIds = session.allToolPartIds();
        phase = "continuation";
        const continued = await session.submit(
          "Without tools, confirm Project Cedar and its Owner from the prior conversation.",
        );
        expect(continued.result.prompt.status).toBe("succeeded");
        const before = session.nativeStateHashes("before-reopen");
        phase = "reopen";
        await session.reopen();
        expect(session.nativeStateHashes("after-reopen")).toEqual(before);
        phase = "post-reopen";
        const reopened = await session.submit(
          "Without tools, confirm the Project and Owner again.",
        );
        expect(reopened.result.prompt.status).toBe("succeeded");
        expect(
          reopened.checkpoint.answer.project &&
            reopened.checkpoint.answer.owner,
        ).toBe(true);
        expect(session.allToolPartIds()).toEqual(toolIds);
      }
      phase = "final-invariants";
      expect(
        audit.requests
          .filter((row) => row.purpose === "agent-step")
          .every((row) => row.http.length > 0),
      ).toBe(true);
      if (["stage-a", "e1", "compaction"].includes(audit.mode)) {
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
      expect(session.wire.length).toBeLessThanOrEqual(20);
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
              injection:
                audit.mode === "transport" || audit.mode === "cancel"
                  ? "real upstream stream plus local fault/cancellation"
                  : isLength
                    ? "real provider length terminal; test max output 128"
                    : undefined,
              ...(publicAudit(audit) as object),
              failureHistory,
              projectionChecks,
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
          await rm(session.root, { recursive: true, force: true });
        }
      }
    }
  });
});
