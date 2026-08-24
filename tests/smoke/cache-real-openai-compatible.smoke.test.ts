import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertAppendExtension,
  cacheReadUsages,
  CACHE_FIXTURE_FORCE_MARKER,
  CACHE_FIXTURE_MCP_TOOL,
  CACHE_FIXTURE_READ_TOOL,
  createRealCacheHarness,
  resolveOpenAiCompatibleProfile,
  uniqueCacheMarker,
} from "./real-cache-harness.js";

const runOpenAiCompatible =
  process.env.OHBABY_RUN_REAL_CACHE_OPENAI_COMPAT === "1";
const runM13 = process.env.OHBABY_RUN_REAL_CACHE_M13 === "1";

describe("real OpenAI-compatible prompt cache", () => {
  (runOpenAiCompatible ? it : it.skip)(
    "records a real OpenAI-compatible cache read",
    async () => {
      const profile = resolveOpenAiCompatibleProfile();
      const harness = await createRealCacheHarness(profile);
      const marker = uniqueCacheMarker("openai-compatible");
      const sessionId = `cache-openai-${marker}`;

      try {
        const first = await harness.runTurn({
          prompt: [
            `Verification marker: ${marker}.`,
            CACHE_FIXTURE_FORCE_MARKER,
            `Call ${CACHE_FIXTURE_READ_TOOL} exactly once with path \"cache-fixture.txt\".`,
            "After receiving the tool result, reply with only OHBABY_REAL_CACHE_OPENAI_OK.",
          ].join(" "),
          sessionId,
        });
        const second = await harness.runTurn({
          prompt:
            "Keep all prior context and reply with only OHBABY_REAL_CACHE_OPENAI_FOLLOWUP_OK. Do not call a tool.",
          sessionId,
        });
        const projections = [...first.projections, ...second.projections];
        const usages = [...first.usages, ...second.usages];

        expect(harness.fixtureExecutions()).toBe(1);
        expect(projections.length).toBeGreaterThanOrEqual(3);
        expect(projections.length).toBeLessThanOrEqual(4);
        for (let index = 1; index < projections.length; index += 1) {
          const left = projections[index - 1];
          const right = projections[index];
          if (!left || !right) {
            throw new Error("missing OpenAI-compatible request projection");
          }
          assertAppendExtension(left, right);
        }
        expect(projections[0]?.toolNames).toEqual([
          CACHE_FIXTURE_READ_TOOL,
          "select_tools",
        ]);
        expect(
          new Set(
            projections.map((projection) => projection.promptCacheStrategy),
          ),
        ).toEqual(
          new Set([
            profile.provider === "openai"
              ? "openai-keyed-implicit"
              : "observe-only",
          ]),
        );
        expect(cacheReadUsages(usages.slice(1)).length).toBeGreaterThan(0);
        expect(
          cacheReadUsages(await harness.metadataUsages(sessionId)).length,
        ).toBeGreaterThan(0);
        await expect(access(harness.evidencePath)).resolves.toBeUndefined();
      } finally {
        await harness.close();
      }
    },
    300_000,
  );

  (runM13 ? it : it.skip)(
    "M13 restores cache reads after one tool epoch transition",
    async () => {
      const profile = resolveOpenAiCompatibleProfile();
      const harness = await createRealCacheHarness(profile);
      const marker = uniqueCacheMarker("m13");
      const sessionId = `cache-m13-${marker}`;

      try {
        const epochZeroFirst = await harness.runTurn({
          prompt: [
            `Marker ${marker}.`,
            CACHE_FIXTURE_FORCE_MARKER,
            `Call ${CACHE_FIXTURE_READ_TOOL} exactly once with path \"cache-fixture.txt\".`,
            "After receiving the result, reply with only M13_EPOCH_ZERO_FIRST.",
          ].join(" "),
          sessionId,
        });
        expect(harness.fixtureExecutions()).toBe(1);
        expect(epochZeroFirst.projections).toHaveLength(2);
        expect(cacheReadUsages(epochZeroFirst.usages.slice(1))).toHaveLength(1);

        await harness.activateMcpTool(sessionId);
        const epochOneFirst = await harness.runTurn({
          maxSteps: 2,
          prompt: "Reply with only M13_EPOCH_ONE_FIRST. Do not call tools.",
          sessionId,
        });
        const epochOneSecond = await harness.runTurn({
          maxSteps: 2,
          prompt: "Reply with only M13_EPOCH_ONE_SECOND. Do not call tools.",
          sessionId,
        });
        const projections = [
          ...epochZeroFirst.projections,
          ...epochOneFirst.projections,
          ...epochOneSecond.projections,
        ];

        expect(projections).toHaveLength(4);
        expect(
          epochZeroFirst.projections.every(
            (projection) => projection.toolEpoch === 0,
          ),
        ).toBe(true);
        expect(
          [...epochOneFirst.projections, ...epochOneSecond.projections].every(
            (projection) => projection.toolEpoch === 1,
          ),
        ).toBe(true);
        expect(projections[0]?.toolNames).toEqual([
          CACHE_FIXTURE_READ_TOOL,
          "select_tools",
        ]);
        expect(epochOneFirst.projections[0]?.toolNames).toEqual([
          CACHE_FIXTURE_READ_TOOL,
          "select_tools",
          CACHE_FIXTURE_MCP_TOOL,
        ]);
        const epochOneLeft = epochOneFirst.projections[0];
        const epochOneRight = epochOneSecond.projections[0];
        if (!epochOneLeft || !epochOneRight) {
          throw new Error("missing M13 epoch-one request projection");
        }
        assertAppendExtension(epochOneLeft, epochOneRight);
        expect(cacheReadUsages(epochOneSecond.usages).length).toBeGreaterThan(
          0,
        );
        await expect(access(harness.evidencePath)).resolves.toBeUndefined();
      } finally {
        await harness.close();
      }
    },
    300_000,
  );
});
