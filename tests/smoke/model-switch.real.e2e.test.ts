import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFormalCacheSession } from "./formal-cache-session.js";
import { decideControlledPermission } from "./formal-cache-live-context.js";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";

interface ResumeProviderRow {
  id: number;
  sessionId?: string;
  purpose?: string;
  replayStateCount: number;
  replayStateHashes: string[];
}
interface ResumeWireRow {
  kind: string;
  context?: { id?: number };
  protocol?: string;
  model?: string;
  path: string;
  status?: number;
}
interface ResumeRouteEvidence {
  providerBoundary: number;
  oldSessionId: string;
  oldRouteReplayStateHashes: string[];
  answer?: { project: boolean; release: boolean; owner: boolean };
}

/** Pure guard shared by the live run and adversarial, network-free fixtures. */
function resumedRouteViolations(
  providerRequests: readonly ResumeProviderRow[],
  wire: readonly ResumeWireRow[],
  resume: ResumeRouteEvidence,
  destination: { protocol: string; model: string },
): string[] {
  const rows = providerRequests
    .slice(resume.providerBoundary)
    .filter(
      (row) =>
        row.sessionId === resume.oldSessionId && row.purpose === "agent-step",
    );
  const failures: string[] = [];
  if (!rows.length) return ["NO_RESUMED_AGENT_REQUESTS"];
  if (
    rows[0]!.replayStateCount !== 0 ||
    rows[0]!.replayStateHashes.length !== 0
  )
    failures.push("FIRST_RESUMED_REQUEST_HAS_NATIVE_STATE");
  const oldHashes = new Set(resume.oldRouteReplayStateHashes);
  const expectedPath = {
    "openai-compatible": "/api/v1/chat/completions",
    "openai-responses": "/api/v1/responses",
    anthropic: "/api/anthropic/v1/messages",
  }[destination.protocol];
  for (const row of rows) {
    if (row.replayStateHashes.some((hash) => oldHashes.has(hash)))
      failures.push("OLD_ROUTE_NATIVE_STATE_REPLAYED");
    const requests = wire.filter(
      (item) => item.kind === "generation" && item.context?.id === row.id,
    );
    if (!requests.length) failures.push("RESUMED_PROVIDER_REQUEST_HAS_NO_HTTP");
    if (
      requests.some(
        (item) =>
          item.protocol !== destination.protocol ||
          item.model !== destination.model ||
          item.path !== expectedPath ||
          item.status !== 200,
      )
    )
      failures.push("RESUMED_HTTP_ROUTE_MISMATCH");
  }
  return failures;
}

describe("Stage B resumed-route evidence guard (no network)", () => {
  const destination = {
    protocol: "openai-responses",
    model: "destination-model",
  };
  const resume = {
    providerBoundary: 1,
    oldSessionId: "old-session",
    oldRouteReplayStateHashes: ["old-native"],
  };
  function fixture(): { rows: ResumeProviderRow[]; wire: ResumeWireRow[] } {
    return {
      rows: [
        {
          id: 1,
          sessionId: "old-session",
          purpose: "agent-step",
          replayStateCount: 1,
          replayStateHashes: ["old-native"],
        },
        {
          id: 2,
          sessionId: "old-session",
          purpose: "agent-step",
          replayStateCount: 0,
          replayStateHashes: [],
        },
        {
          id: 3,
          sessionId: "old-session",
          purpose: "agent-step",
          replayStateCount: 1,
          replayStateHashes: ["new-native"],
        },
      ],
      wire: [2, 3].map((id) => ({
        kind: "generation",
        context: { id },
        protocol: destination.protocol,
        model: destination.model,
        path: "/api/v1/responses",
        status: 200,
      })),
    };
  }
  it("allows new-route native state after the first resumed request", () => {
    const { rows, wire } = fixture();
    expect(resumedRouteViolations(rows, wire, resume, destination)).toEqual([]);
  });
  it("requires new requests from the resumed old session", () => {
    const { rows, wire } = fixture();
    expect(
      resumedRouteViolations(rows.slice(0, 1), wire, resume, destination),
    ).toEqual(["NO_RESUMED_AGENT_REQUESTS"]);
  });
  it.each(["protocol", "model", "path", "status"] as const)(
    "rejects an earlier wrong %s even if the last request is correct",
    (field) => {
      const { rows, wire } = fixture();
      wire[0] = { ...wire[0]!, [field]: field === "status" ? 500 : "wrong" };
      expect(resumedRouteViolations(rows, wire, resume, destination)).toContain(
        "RESUMED_HTTP_ROUTE_MISMATCH",
      );
    },
  );
  it("requires an HTTP observation for every resumed provider request", () => {
    const { rows, wire } = fixture();
    expect(
      resumedRouteViolations(rows, wire.slice(1), resume, destination),
    ).toContain("RESUMED_PROVIDER_REQUEST_HAS_NO_HTTP");
  });
  it("rejects native state on the first resumed request", () => {
    const { rows, wire } = fixture();
    rows[1] = {
      ...rows[1]!,
      replayStateCount: 1,
      replayStateHashes: ["unseen-old-native"],
    };
    expect(resumedRouteViolations(rows, wire, resume, destination)).toContain(
      "FIRST_RESUMED_REQUEST_HAS_NATIVE_STATE",
    );
  });
  it("rejects old-route state reintroduced in a later request", () => {
    const { rows, wire } = fixture();
    rows[2] = { ...rows[2]!, replayStateHashes: ["old-native"] };
    expect(resumedRouteViolations(rows, wire, resume, destination)).toContain(
      "OLD_ROUTE_NATIVE_STATE_REPLAYED",
    );
  });
});

// Only local tool timing is controlled; the tool and all model HTTP responses are real.
const gate = vi.hoisted(() => ({
  path: "",
  enabled: false,
  started: () => {},
  wait: Promise.resolve(),
}));
vi.mock(
  "../../packages/ohbaby-agent/src/tools/read.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../packages/ohbaby-agent/src/tools/read.js")
      >();
    return {
      ...original,
      createReadTool: () => {
        const tool = original.createReadTool();
        return {
          ...tool,
          async execute(...args: Parameters<typeof tool.execute>) {
            if (gate.enabled && args[0].file_path === gate.path) {
              gate.enabled = false;
              gate.started();
              await gate.wait;
            }
            return tool.execute(...args);
          },
        };
      },
    };
  },
);

const pairs = [
  ["zenmux-gpt56-luna-chat", "zenmux-gpt56-luna-responses"],
  ["zenmux-gpt56-luna-responses", "zenmux-claude-sonnet5-anthropic"],
  ["zenmux-claude-sonnet5-anthropic", "zenmux-gpt56-luna-chat"],
] as const;

describe.runIf(process.env.OHBABY_RUN_REAL_MODEL_SWITCH === "1")(
  "real model save while a tool is waiting",
  () => {
    it("keeps the old run, queues a new session, then switches and restores", async () => {
      const pair = pairs.find(
        ([id]) => id === process.env.OHBABY_REAL_SWITCH_FROM,
      );
      if (!pair) throw new Error("Select a fixed switch pair");
      const from = NATIVE_REAL_PROFILES.find((p) => p.id === pair[0])!;
      const to = NATIVE_REAL_PROFILES.find((p) => p.id === pair[1])!;
      const session = await createFormalCacheSession(from.id, {
        maxRequests: 20,
      });
      const oldSessionId = randomUUID();
      const newSessionId = randomUUID();
      const evidencePath = join(
        ".ohbaby/test-evidence/improve-8/stage-b",
        `${from.protocol}.json`,
      );
      await mkdir(dirname(evidencePath), { recursive: true });
      const configPath = join(session.root, "config/model.json");
      // Stage B pre-seeds exact verified capabilities; discovery is Stage C's gate.
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.models.push({
        provider: "zenmux",
        model: to.model,
        interfaceProvider: to.protocol,
        baseUrl: to.baseUrl,
        contextWindowTokens: 128000,
        maxOutputTokens: 4096,
        reasoningCapabilities: to.capabilities,
      });
      await writeFile(configPath, JSON.stringify(config));
      const timeline: string[] = [];
      const completions: { session: string; status: string }[] = [];
      const permissionErrors: string[] = [];
      let resumeEvidence: ResumeRouteEvidence | undefined;
      let signalHeld!: () => void;
      let releaseTool!: () => void;
      const toolWaiting = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      gate.path = session.readFilePath;
      gate.enabled = true;
      gate.started = () => {
        timeline.push("old-tool-waiting");
        signalHeld();
      };
      gate.wait = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const tasks = new Set<Promise<void>>();
      let phase = "old-run";
      let failure: { phase: string; code: string } | undefined;
      const listen = (): (() => void) =>
        session.backend.subscribeEvents((event) => {
          if (event.type !== "permission.requested") return;
          const work = (async () => {
            const selection = decideControlledPermission(
              event.request,
              await session.backend.getSnapshot(),
              dirname(session.readFilePath),
              session.readFilePath,
            );
            await session.backend.respondPermission(event.request.id, {
              choiceId: selection.choiceId,
              remember: false,
            });
          })().catch(() => {
            permissionErrors.push("PERMISSION_HANDLER_FAILED");
          });
          tasks.add(work);
          void work.finally(() => tasks.delete(work));
        });
      let off = listen();
      async function completed(promptId: string, label: string): Promise<void> {
        const result = await session.backend.waitForPrompt(promptId, {
          signal: AbortSignal.timeout(180000),
        });
        completions.push({ session: label, status: result.prompt.status });
        expect(result.prompt.status).toBe("succeeded");
        timeline.push(`${label}-completed`);
      }
      try {
        const old = await session.backend.submitPromptAccepted(
          `Use read on ${session.readFilePath}, with only file_path. Report Project, Release and Owner. Do not change files or use shell.`,
          { sessionId: oldSessionId },
        );
        await Promise.race([
          toolWaiting,
          session.backend
            .waitForPrompt(old.promptId, {
              signal: AbortSignal.timeout(120000),
            })
            .then(() => {
              throw new Error("OLD_RUN_DID_NOT_WAIT_FOR_READ");
            }),
        ]);
        expect(gate.enabled).toBe(false);
        phase = "save-while-running";
        const saved = await session.backend.connectModel({
          provider: "zenmux",
          model: to.model,
          baseUrl: to.baseUrl,
          interfaceProvider: to.protocol,
          apiKeyEnv: "ZENMUX_API_KEY",
          maxOutputTokens: 4096,
          contextWindowTokens: 128000,
        });
        expect(saved.saved).toBe(true);
        timeline.push("new-model-saved");
        phase = "accept-new";
        const next = await session.backend.submitPromptAccepted(
          "Reply exactly: SWITCH_READY. Do not use any tools.",
          { sessionId: newSessionId },
        );
        timeline.push("new-prompt-accepted");
        await session.backend.getSnapshot();
        expect(
          session.providerRequests.some((r) => r.sessionId === newSessionId),
        ).toBe(false);
        expect(
          session.wire
            .filter((r) => r.kind === "generation")
            .every((r) => r.protocol === from.protocol),
        ).toBe(true);
        timeline.push("old-tool-released");
        releaseTool();
        phase = "old-completion";
        await completed(old.promptId, "old");
        phase = "new-completion";
        await completed(next.promptId, "new");
        await Promise.all([...tasks]);
        const snapshot = await session.backend.getSnapshot();
        const oldText = snapshot.sessions
          .find((s) => s.id === oldSessionId)
          ?.messages.flatMap((m) =>
            m.parts.filter((p) => p.type === "text").map((p) => p.text),
          )
          .join(" ");
        expect(oldText).toContain("Lin");
        const newText = snapshot.sessions
          .find((s) => s.id === newSessionId)
          ?.messages.findLast((m) => m.role === "assistant")
          ?.parts.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(" ");
        expect(newText).toContain("SWITCH_READY");
        const rowsFor = (id: string) => {
          const ids = new Set(
            session.providerRequests
              .filter((r) => r.sessionId === id && r.purpose === "agent-step")
              .map((r) => r.id),
          );
          return session.wire.filter(
            (r) => r.kind === "generation" && ids.has(r.context?.id ?? -1),
          );
        };
        const oldRows = rowsFor(oldSessionId);
        expect(oldRows.length).toBeGreaterThanOrEqual(2);
        expect(
          oldRows.every(
            (r) =>
              r.kind === "generation" &&
              r.protocol === from.protocol &&
              r.model === from.model &&
              r.status === 200,
          ),
        ).toBe(true);
        expect(rowsFor(newSessionId).length).toBeGreaterThan(0);
        expect(
          rowsFor(newSessionId).every(
            (r) =>
              r.kind === "generation" &&
              r.protocol === to.protocol &&
              r.model === to.model &&
              r.status === 200,
          ),
        ).toBe(true);
        phase = "reopen";
        await vi.waitFor(
          () =>
            expect(session.providerRequests.every((row) => row.settled)).toBe(
              true,
            ),
          { timeout: 10000 },
        );
        off();
        await session.reopen();
        off = listen();
        // The next user turn in the original session must also use the saved model,
        // keeping visible history without forwarding the old route's opaque state.
        phase = "old-history-new-model";
        resumeEvidence = {
          providerBoundary: session.providerRequests.length,
          oldSessionId,
          oldRouteReplayStateHashes: [
            ...new Set(
              session.providerRequests
                .filter(
                  (row) =>
                    row.sessionId === oldSessionId &&
                    row.purpose === "agent-step",
                )
                .flatMap((row) => row.replayStateHashes),
            ),
          ],
        };
        const resumed = await session.backend.submitPromptAccepted(
          "From our earlier conversation, report Project, Release and Owner again. Do not use tools.",
          { sessionId: oldSessionId },
        );
        await completed(resumed.promptId, "resumed-old-session");
        const after = await session.backend.getSnapshot();
        const answer = after.sessions
          .find((s) => s.id === oldSessionId)
          ?.messages.findLast((m) => m.role === "assistant")
          ?.parts.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(" ");
        resumeEvidence.answer = {
          project: answer?.includes("Cedar") ?? false,
          release: answer?.includes("17") ?? false,
          owner: answer?.includes("Lin") ?? false,
        };
        expect(resumeEvidence.answer).toEqual({
          project: true,
          release: true,
          owner: true,
        });
        expect(
          resumedRouteViolations(
            session.providerRequests,
            session.wire,
            resumeEvidence,
            to,
          ),
        ).toEqual([]);
        expect(permissionErrors).toEqual([]);
      } catch (error) {
        failure = {
          phase,
          code:
            error instanceof Error && error.name === "AssertionError"
              ? "ASSERTION_FAILED"
              : "SWITCH_FAILED",
        };
        throw new Error(`${failure.code} at ${phase}`);
      } finally {
        releaseTool();
        off();
        // close cancels unfinished work on a failed test and drains the observer.
        await session.close();
        await writeFile(
          evidencePath,
          JSON.stringify(
            {
              stage: "B",
              from: from.id,
              to: to.id,
              seededVerifiedCapabilities: true,
              timeline,
              completions,
              permissionErrors,
              resumeEvidence,
              providerRequests: session.providerRequests,
              wire: session.wire,
              result: failure ? "failed" : "passed",
              ...(failure
                ? { failure, diagnosticWorkspace: session.root }
                : {}),
            },
            null,
            2,
          ) + "\n",
        );
        if (!failure) await rm(session.root, { recursive: true, force: true });
      }
    }, 600000);
  },
);
