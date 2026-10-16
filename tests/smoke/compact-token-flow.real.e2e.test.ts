import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFormalCacheSession } from "./formal-cache-session.js";
import {
  COMPACT_TOKEN_PROFILES,
  generationEndpoint,
} from "./compact-token-profiles.js";
import type { FormalCacheGenerationEvidence } from "./formal-cache-observer.js";

const enabled = process.env.OHBABY_RUN_COMPACT_TOKEN_E2E === "1";
const acceptance = "AMBER-731";
const question = "Without tools, reply with only the retained release code.";
const lines = Array.from(
  { length: 900 },
  (_, i) =>
    `fixture ${String(i + 1).padStart(4, "0")}: component=preview status=passed duration_ms=${String(20 + (i % 19))} cache=warm note=synthetic layout observation; no changes required; keep only aggregate result.`,
);

/** Total input, not merely uncached/billable input. Anthropic buckets are additive. */
function rawInput(row: FormalCacheGenerationEvidence): number {
  const u = row.finalUsage;
  const total =
    row.protocol === "anthropic"
      ? Number(u.input_tokens) +
        Number(u.cache_read_input_tokens ?? 0) +
        Number(u.cache_creation_input_tokens ?? 0)
      : Number(u.prompt_tokens ?? u.input_tokens);
  expect(Number.isFinite(total)).toBe(true);
  expect(total).toBeGreaterThan(0);
  return total;
}

describe.runIf(enabled)("real compact token data flow", () => {
  it("reduces the actual next request and provider input usage, surviving database reopen", async () => {
    const profile = COMPACT_TOKEN_PROFILES.find(
      (p) => p.id === process.env.OHBABY_COMPACT_TOKEN_PROFILE,
    );
    if (!profile) throw new Error("Select OHBABY_COMPACT_TOKEN_PROFILE");
    const dir =
      process.env.OHBABY_COMPACT_TOKEN_EVIDENCE_DIR ??
      ".ohbaby/test-evidence/compact-token-flow";
    await mkdir(dir, { recursive: true });
    let phase = "setup";
    const markers: {
      sequence: number;
      purpose?: string;
      rawLines: number;
      summary: boolean;
      code: boolean;
    }[] = [];
    const evidence: Record<string, unknown> = {
      profile: profile.id,
      model: profile.model,
      protocol: profile.protocol,
      recordedAt: new Date().toISOString(),
    };
    const session = await createFormalCacheSession(profile.id, {
      profile,
      reasoningEnabled: false,
      maxRequests: 12,
      observeWireRequest: {
        generationEndpoint: {
          url: generationEndpoint(profile),
          protocol: profile.protocol,
        },
        onRequest(body, row) {
          const text = JSON.stringify(body);
          markers.push({
            sequence: row.sequence,
            purpose: row.context?.purpose,
            rawLines: lines.filter((line) => text.includes(line)).length,
            summary: text.includes("<context_summary>"),
            code: text.includes(acceptance),
          });
        },
      },
    });
    const latestAgentWire = (): FormalCacheGenerationEvidence => {
      const row = session.wire
        .filter(
          (r): r is FormalCacheGenerationEvidence =>
            r.kind === "generation" && r.context?.purpose === "agent-step",
        )
        .at(-1);
      if (!row) throw new Error(`Missing agent request during ${phase}`);
      return row;
    };
    async function ask(text: string): Promise<void> {
      const r = await session.submit(text);
      expect(r.result.prompt.status, phase).toBe("succeeded");
      expect(
        r.checkpoint.toolCalls,
        "no tools needed for this fixture",
      ).toEqual([]);
    }
    try {
      phase = "seed";
      await ask(
        `This is a synthetic compaction acceptance test. Retain release code ${acceptance}, project Amber Beacon, keyboard navigation required, and no new dependencies. The following 900 redundant observations can later be summarized as all passed. Do not use tools or write files. Reply only READY.\n\n${lines.join("\n")}`,
      );
      phase = "before";
      await ask(question);
      const before = latestAgentWire();
      expect(
        markers.find((m) => m.sequence === before.sequence)?.rawLines,
      ).toBe(900);
      const beforeUsage = await session.backend.getContextWindowUsage({
        sessionId: (await session.status()).sessionId,
      });
      phase = "compact";
      const compact = await session.compact();
      expect(compact.result.status).toBe("compacted");
      expect(compact.result.usageAfter.currentTokens).toBeLessThan(
        compact.result.usageBefore.currentTokens,
      );
      expect(compact.checkpoint.persisted.context.summaryParts).toBeGreaterThan(
        0,
      );
      expect(compact.checkpoint.persisted.context.retiredParts).toBeGreaterThan(
        0,
      );
      evidence.compaction = compact.result;
      evidence.beforeUsage = beforeUsage;
      phase = "after";
      await ask(question);
      const after = latestAgentWire();
      phase = "reopen";
      await session.reopen();
      await ask(question);
      const reopened = latestAgentWire();
      // save drains response clones before inspecting raw wire usage.
      await session.save(join(dir, `${profile.id}.wire.json`));
      const mainRows = session.providerRequests.filter(
        (r) => r.purpose === "agent-step",
      );
      for (const row of [before, after, reopened]) {
        expect(row.status).toBe(200);
        expect(row.captureError).toBeUndefined();
        const normalized = mainRows.find((r) => r.id === row.context?.id)?.usage
          ?.inputTokens;
        expect(normalized).toBe(rawInput(row));
      }
      for (const row of [after, reopened]) {
        expect(markers.find((m) => m.sequence === row.sequence)).toMatchObject({
          rawLines: 0,
          summary: true,
          code: true,
        });
        expect(row.input.bytes).toBeLessThan(before.input.bytes * 0.5);
        expect(rawInput(row)).toBeLessThan(rawInput(before) * 0.7);
        expect(row.tools).toEqual(before.tools);
        expect(row.system).toEqual(before.system);
      }
      const snapshot = await session.backend.getSnapshot();
      const lastAnswer = snapshot.sessions
        .find((s) => s.id === compact.result.sessionId)
        ?.messages.filter((m) => m.role === "assistant")
        .at(-1);
      expect(JSON.stringify(lastAnswer)).toContain(acceptance);
      evidence.comparison = {
        before: {
          wireInputBytes: before.input.bytes,
          providerInputTokens: rawInput(before),
        },
        after: {
          wireInputBytes: after.input.bytes,
          providerInputTokens: rawInput(after),
        },
        reopened: {
          wireInputBytes: reopened.input.bytes,
          providerInputTokens: rawInput(reopened),
        },
        estimatedBefore: compact.result.usageBefore.currentTokens,
        estimatedAfter: compact.result.usageAfter.currentTokens,
      };
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed";
      evidence.failure = {
        phase,
        code: error instanceof Error ? error.name : "UNKNOWN",
      };
      throw error;
    } finally {
      evidence.markers = markers;
      try {
        try {
          await session.save(join(dir, `${profile.id}.wire.json`));
        } finally {
          await session.close();
        }
      } catch (error) {
        evidence.status = "failed";
        evidence.failure = {
          phase: "finalize",
          code: error instanceof Error ? error.name : "UNKNOWN",
        };
        throw error;
      } finally {
        await writeFile(
          join(dir, `${profile.id}.json`),
          JSON.stringify(evidence, null, 2) + "\n",
        );
      }
    }
  }, 600000);
});
