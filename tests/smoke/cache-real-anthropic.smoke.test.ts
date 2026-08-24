import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertAppendExtension,
  cacheReadUsages,
  cacheWriteOrReadUsages,
  CACHE_FIXTURE_FORCE_MARKER,
  CACHE_FIXTURE_READ_TOOL,
  createRealCacheHarness,
  resolveAnthropicProfile,
  uniqueCacheMarker,
} from "./real-cache-harness.js";

const runAnthropic = process.env.OHBABY_RUN_REAL_CACHE_ANTHROPIC === "1";

describe("real Anthropic prompt cache", () => {
  (runAnthropic ? it : it.skip)(
    "records real Anthropic cache read usage",
    async () => {
      const profile = resolveAnthropicProfile();
      const harness = await createRealCacheHarness(profile);
      const marker = uniqueCacheMarker("anthropic");
      const sessionId = `cache-anthropic-${marker}`;
      const childSessionId = `${sessionId}-child`;
      const childScopeId = "explore-cache-smoke";

      try {
        const first = await harness.runTurn({
          prompt: [
            `Verification marker: ${marker}.`,
            CACHE_FIXTURE_FORCE_MARKER,
            `Call ${CACHE_FIXTURE_READ_TOOL} exactly once with path \"cache-fixture.txt\".`,
            "After receiving the result, reply only OHBABY_REAL_CACHE_ANTHROPIC_OK.",
          ].join(" "),
          sessionId,
        });
        const followup = await harness.runTurn({
          prompt:
            "Keep all prior context and reply only OHBABY_REAL_CACHE_ANTHROPIC_FOLLOWUP_OK. Do not call a tool.",
          sessionId,
        });
        const childFirst = await harness.runTurn({
          contextScopeId: childScopeId,
          isSubagent: true,
          prompt: [
            `Independent child marker ${marker}.`,
            CACHE_FIXTURE_FORCE_MARKER,
            `Call ${CACHE_FIXTURE_READ_TOOL} exactly once with path \"cache-fixture.txt\".`,
            "After receiving the result, reply only OHBABY_REAL_CACHE_ANTHROPIC_CHILD_OK.",
          ].join(" "),
          sessionId: childSessionId,
        });
        const childFollowup = await harness.runTurn({
          contextScopeId: childScopeId,
          isSubagent: true,
          maxSteps: 2,
          prompt:
            "Keep this child context and reply only OHBABY_REAL_CACHE_ANTHROPIC_CHILD_FOLLOWUP_OK. Do not call tools.",
          sessionId: childSessionId,
        });
        const primaryProjections = [
          ...first.projections,
          ...followup.projections,
        ];
        const primaryUsages = [...first.usages, ...followup.usages];
        const childProjections = [
          ...childFirst.projections,
          ...childFollowup.projections,
        ];
        const childUsages = [...childFirst.usages, ...childFollowup.usages];

        expect(harness.fixtureExecutions()).toBe(2);
        expect(primaryProjections.length).toBeGreaterThanOrEqual(3);
        expect(primaryProjections.length).toBeLessThanOrEqual(4);
        expect(childProjections.length).toBeGreaterThanOrEqual(3);
        expect(childProjections.length).toBeLessThanOrEqual(4);
        for (let index = 1; index < primaryProjections.length; index += 1) {
          const left = primaryProjections[index - 1];
          const right = primaryProjections[index];
          if (!left || !right) {
            throw new Error("missing Anthropic request projection");
          }
          assertAppendExtension(left, right);
        }
        expect(
          new Set(
            [...primaryProjections, ...childProjections].map(
              (projection) => projection.promptCacheStrategy,
            ),
          ),
        ).toEqual(
          new Set([
            profile.provider === "zenmux"
              ? "anthropic-explicit-last-block"
              : "anthropic-top-level-auto",
          ]),
        );
        if (profile.allowsUnreportedImplicitCacheWrite === true) {
          expect(primaryUsages[0]?.inputBreakdown?.observed).toEqual({
            cacheRead: true,
            cacheWrite: true,
          });
        } else {
          expect(
            cacheWriteOrReadUsages(primaryUsages.slice(0, 1)),
          ).toHaveLength(1);
        }
        expect(cacheReadUsages(primaryUsages.slice(1)).length).toBeGreaterThan(
          0,
        );
        expect(
          cacheReadUsages(await harness.metadataUsages(sessionId)).length,
        ).toBeGreaterThan(0);
        for (let index = 1; index < childProjections.length; index += 1) {
          const left = childProjections[index - 1];
          const right = childProjections[index];
          if (!left || !right) {
            throw new Error("missing child Anthropic request projection");
          }
          assertAppendExtension(left, right);
        }
        expect(childProjections[0]).toMatchObject({
          contextScopeId: childScopeId,
          sessionId: childSessionId,
        });
        if (profile.allowsUnreportedImplicitCacheWrite === true) {
          expect(childUsages[0]?.inputBreakdown?.observed).toEqual({
            cacheRead: true,
            cacheWrite: true,
          });
        } else {
          expect(cacheWriteOrReadUsages(childUsages.slice(0, 1))).toHaveLength(
            1,
          );
        }
        expect(cacheReadUsages(childUsages.slice(1)).length).toBeGreaterThan(0);
        expect(
          cacheReadUsages(
            await harness.metadataUsages(childSessionId, childScopeId),
          ).length,
        ).toBeGreaterThan(0);
        expect(childProjections[0]?.messageDigests).not.toEqual(
          primaryProjections[0]?.messageDigests,
        );
        await expect(access(harness.evidencePath)).resolves.toBeUndefined();
      } finally {
        await harness.close();
      }
    },
    300_000,
  );
});
