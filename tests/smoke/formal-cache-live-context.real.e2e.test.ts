import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFormalCacheSession } from "./formal-cache-session.js";
import {
  LIVE_CONTEXT_PROFILES,
  createCompactionNotes,
  safeLiveContextFailure,
  type LiveContextPhase,
} from "./formal-cache-live-context.js";

const enabled = process.env.OHBABY_RUN_REAL_CONTEXT_E2E === "1";

describe.runIf(enabled)("production-backed context migration", () => {
  it("runs one selected protocol through read, continuation and SQLite reopen", async () => {
    const profileId = process.env.OHBABY_REAL_CONTEXT_PROFILE;
    const profile = LIVE_CONTEXT_PROFILES.find((item) => item.id === profileId);
    if (!profile) throw new Error("Select one supported live context profile");
    if (!process.env.ZENMUX_API_KEY?.trim())
      throw new Error(
        "ZENMUX_API_KEY is required; no generation requests made",
      );
    const mode = process.env.OHBABY_REAL_CONTEXT_MODE;
    if (mode !== "baseline" && mode !== "compaction")
      throw new Error("Select baseline or compaction mode");
    const configuredEvidenceDir =
      process.env.OHBABY_REAL_CONTEXT_EVIDENCE_DIR?.trim();
    const evidenceDir = configuredEvidenceDir?.length
      ? configuredEvidenceDir
      : ".ohbaby/test-evidence/improve-6/live-context";
    await mkdir(evidenceDir, { recursive: true });
    const session = await createFormalCacheSession(profile.id, {
      requireDetectedWindow: true,
      maxRequests: 20,
    });
    let failure: ReturnType<typeof safeLiveContextFailure> | undefined;
    let phase: LiveContextPhase = "first-read";
    let evidencePath: string | undefined;
    try {
      // Controlled redundant history gives the unchanged inflation guard useful material.
      const compressibleHistory =
        mode === "compaction" ? createCompactionNotes(30) : "";
      const first = await session.submit(
        `Use the read tool once on the exact file ${session.readFilePath}. Report the Project, Release, and Owner fields exactly. This is a local read-only file; do not use shell commands.${compressibleHistory}`,
      );
      expect(first.result.prompt.status).toBe("succeeded");
      expect(first.checkpoint.toolCalls).toContainEqual({
        name: "read",
        status: "completed",
      });
      expect(first.checkpoint.answer.project).toBe(true);
      expect(first.checkpoint.answer.release).toBe(true);
      expect(first.checkpoint.answer.owner).toBe(true);
      const completedTools = first.checkpoint.persisted.completedTools;
      expect(completedTools.length).toBeGreaterThan(0);
      expect(completedTools.every((tool) => tool.allowed)).toBe(true);
      const expectedToolCalls = session.allToolPartIds();
      expect(expectedToolCalls.ids.length).toBeGreaterThan(0);
      const firstUsage = (
        await session.backend.getSnapshot()
      ).contextWindowUsages?.find(
        (usage) => usage.sessionId === first.checkpoint.cache.sessionId,
      );
      expect(firstUsage?.contextWindowTokens).toBe(
        session.contextWindow.tokens,
      );
      expect(firstUsage?.currentTokens).toBeGreaterThan(0);
      phase = "continuation";
      const second = await session.submit(
        "Without reading the file again, state who owns Project Cedar release 17. Use only the earlier conversation." +
          (mode === "compaction" ? createCompactionNotes(60) : ""),
      );
      expect(second.result.prompt.status).toBe("succeeded");
      expect(second.checkpoint.answer.owner).toBe(true);
      expect(session.allToolPartIds()).toEqual(expectedToolCalls);
      if (mode === "compaction") {
        phase = "pre-compaction";
        const third = await session.submit(
          "Keep the Project, Release, and Owner fields available for the next step. Reply with those three values; do not use tools.",
        );
        expect(third.result.prompt.status).toBe("succeeded");
        expect(session.allToolPartIds()).toEqual(expectedToolCalls);
        const nativeBeforeCompact =
          session.nativeStateHashes("before-compaction");
        expect(nativeBeforeCompact.active.length).toBeGreaterThan(0);
        phase = "compaction";
        const beforeCompact = session.wire.length;
        const compact = await session.compact();
        expect(compact.result.status).toBe("compacted");
        expect(compact.result.compression?.status).toBe("compressed");
        expect(
          session.wire
            .slice(beforeCompact)
            .some(
              (item) =>
                item.kind === "generation" &&
                item.context?.purpose === "context-summary",
            ),
        ).toBe(true);
        expect(
          compact.checkpoint.persisted.context.summaryParts,
        ).toBeGreaterThan(0);
        expect(
          compact.checkpoint.persisted.context.retiredParts,
        ).toBeGreaterThan(0);
        const nativeAfterCompact =
          session.nativeStateHashes("after-compaction");
        expect(
          nativeAfterCompact.retired.some((hash) =>
            nativeBeforeCompact.active.includes(hash),
          ),
        ).toBe(true);
        expect(session.allToolPartIds()).toEqual(expectedToolCalls);
        phase = "post-compaction";
        const afterCompact = await session.submit(
          "After summarization, confirm the Owner field from the retained context. Do not use tools.",
        );
        expect(afterCompact.result.prompt.status).toBe("succeeded");
        expect(afterCompact.checkpoint.answer.owner).toBe(true);
        expect(session.allToolPartIds()).toEqual(expectedToolCalls);
        const compactReplay = session.providerRequests
          .filter((request) => request.purpose === "agent-step")
          .at(-1);
        expect(compactReplay?.replayStateHashes).toEqual(
          nativeAfterCompact.active,
        );
        expect(
          compactReplay?.replayStateHashes.some((hash) =>
            nativeAfterCompact.retired.includes(hash),
          ),
        ).toBe(false);
      }
      const originalSessionId = (await session.status()).sessionId;
      const nativeBefore = session.activeNativeFingerprint("before-reopen");
      if (mode === "baseline") expect(nativeBefore.count).toBeGreaterThan(0);
      const nativeStatesBefore = session.nativeStateHashes("before-reopen");
      phase = "reopen";
      await session.reopen();
      expect(session.activeNativeFingerprint("after-reopen")).toEqual(
        nativeBefore,
      );
      expect(session.nativeStateHashes("after-reopen")).toEqual(
        nativeStatesBefore,
      );
      phase = "post-reopen";
      const afterReopen = await session.submit(
        "After reopening this session, confirm the Project and Owner fields. Do not use tools.",
      );
      expect(afterReopen.result.prompt.status).toBe("succeeded");
      expect(afterReopen.checkpoint.persisted.completedTools).toEqual(
        completedTools,
      );
      expect(afterReopen.checkpoint.cache.sessionId).toBe(originalSessionId);
      expect(afterReopen.checkpoint.answer.project).toBe(true);
      expect(afterReopen.checkpoint.answer.owner).toBe(true);
      expect(session.allToolPartIds()).toEqual(expectedToolCalls);
      const reopenedUsage = (
        await session.backend.getSnapshot()
      ).contextWindowUsages?.find(
        (usage) => usage.sessionId === originalSessionId,
      );
      expect(reopenedUsage?.contextWindowTokens).toBe(
        session.contextWindow.tokens,
      );
      expect(reopenedUsage?.currentTokens).toBeGreaterThan(0);
      const finalMainRequest = session.providerRequests
        .filter((request) => request.purpose === "agent-step")
        .at(-1);
      expect(finalMainRequest?.replayStateHashes).toEqual(
        nativeStatesBefore.active,
      );
      expect(
        finalMainRequest?.replayStateHashes.some((hash) =>
          nativeStatesBefore.retired.includes(hash),
        ),
      ).toBe(false);
      expect(session.contextUpdates.length).toBeGreaterThan(0);
      expect(
        session.contextUpdates.every(
          (usage) => usage.contextWindowTokens === session.contextWindow.tokens,
        ),
      ).toBe(true);
      expect(session.contextWindow.source).toBe("detected");
      expect(session.wire.length).toBeLessThanOrEqual(20);
      expect(session.providerRequests.every((item) => item.settled)).toBe(true);
      expect(
        session.providerRequests.some(
          (item) => item.purpose !== "session-title",
        ),
      ).toBe(true);
      expect(session.permissionErrors).toEqual([]);
      expect(
        session.permissionDecisions.every(
          (decision) => !decision.allowed || decision.toolName === "read",
        ),
      ).toBe(true);
    } catch (error) {
      failure = safeLiveContextFailure(error, phase);
      throw new Error(`${failure.code} at ${failure.phase}`);
    } finally {
      try {
        phase = "evidence";
        evidencePath = join(
          evidenceDir,
          `${profile.id}-${mode}-${String(Date.now())}.json`,
        );
        await session.save(evidencePath);
        if (failure)
          await writeFile(
            `${evidencePath}.failure.json`,
            JSON.stringify({ profile: profile.id, mode, failure }) + "\n",
          );
        process.stdout.write(
          JSON.stringify({ profile: profile.id, mode, evidencePath, failure }) +
            "\n",
        );
      } finally {
        await session.close();
        if (process.env.OHBABY_REAL_CONTEXT_KEEP_WORKSPACE !== "1")
          await rm(session.root, { recursive: true, force: true });
      }
    }
  }, 600000);
});
