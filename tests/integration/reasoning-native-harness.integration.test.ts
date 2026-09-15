import { describe, expect, it } from "vitest";
import {
  NATIVE_REAL_PROFILES,
  extractNativeSnapshotEvidence,
  extractChatDetailEvidence,
  runNativeProfile,
} from "../smoke/reasoning-native-harness.js";
import { nativeFixtureTransport } from "../smoke/reasoning-native-fixture.js";

describe("native reasoning E2E harness through real SDK Lifecycle SQLite Context tracker", () => {
  it("separates runtime success from an upstream OFF reasoning semantic failure", async () => {
    const profile = NATIVE_REAL_PROFILES[0];
    const fixture = nativeFixtureTransport(profile);
    const result = await runNativeProfile(profile, {
      apiKey: "fake-sensitive-key",
      transport: async (input, init) => {
        const response = await fixture(input, init);
        return new Response(
          (await response.text()).replaceAll(
            '"reasoning_tokens":0',
            '"reasoning_tokens":2',
          ),
          { headers: response.headers },
        );
      },
    });
    expect(result.actualHttpRequests).toBe(4);
    expect(result.modes[1].runtimePassed).toBe(true);
    expect(result.modes[1].disabledEffect).toBe("reasoning_observed");
    expect(result.modes[1].failure).toBe(
      "DISABLED_REASONING_SEMANTICS_NOT_OBSERVED",
    );
    expect(result.passed).toBe(false);
  });
  it("distinguishes documented decimal-string Chat indexes without retaining arbitrary strings", () => {
    const wire = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            reasoning_details: [
              { type: "reasoning.encrypted", index: "0" },
              { type: "reasoning.encrypted", index: "private-index" },
            ],
          },
        },
      ],
    })}\n\n`;
    const evidence = extractChatDetailEvidence(wire);
    expect(evidence[0].index).toEqual({
      kind: "string",
      length: 1,
      canonicalDecimal: true,
      value: 0,
    });
    expect(evidence[1].index.canonicalDecimal).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain("private-index");
  });
  it("bounds a diagnostic to one HTTP request even if the first generation succeeds", async () => {
    const profile = NATIVE_REAL_PROFILES[0];
    const result = await runNativeProfile(profile, {
      apiKey: "fake-sensitive-key",
      transport: nativeFixtureTransport(profile),
      requestLimit: 1,
    });
    expect(result.runKind).toBe("diagnostic");
    expect(result.actualHttpRequests).toBe(1);
    expect(result.limits.maxRequests).toBe(1);
    expect(result.passed).toBe(false);
  });
  it("records nullable Chat detail structure without retaining private values", () => {
    const evidence = extractChatDetailEvidence(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.encrypted", index: null, id: "private-id", data: "private-cipher", signature: null, format: "private-format", "private-field": "private-value" }] } }] })}\n\n`,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0].index).toEqual({ kind: "null" });
    expect(evidence[0].unknownFieldCount).toBe(1);
    expect(evidence[0].payloads.signature).toEqual({ kind: "null" });
    expect(evidence[0].payloads.data.length).toBe(14);
    expect(JSON.stringify(evidence)).not.toContain("private");
  });
  it("records only hashed snapshot differences for regenerated encrypted content", () => {
    const base = {
      id: "private-item-id",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "private summary" }],
    };
    const events = [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...base, encrypted_content: "private-cipher-one" },
      },
      {
        type: "response.completed",
        response: {
          output: [{ ...base, encrypted_content: "private-cipher-two" }],
        },
      },
    ];
    const evidence = extractNativeSnapshotEvidence(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
    expect(evidence).toHaveLength(2);
    expect(evidence[0].idHash).toBe(evidence[1].idHash);
    expect(evidence[0].projectionHash).toBe(evidence[1].projectionHash);
    expect(evidence[0].encrypted.hash).not.toBe(evidence[1].encrypted.hash);
    expect(JSON.stringify(evidence)).not.toContain("private-");
    expect(JSON.stringify(evidence)).not.toContain("private summary");
  });

  it("retains completed frame usage and safe snapshots when the HTTP body fails late", async () => {
    const profile = NATIVE_REAL_PROFILES[1];
    const fixture = nativeFixtureTransport(profile);
    const result = await runNativeProfile(profile, {
      apiKey: "fake-sensitive-key",
      transport: async (input, init) => {
        const response = await fixture(input, init);
        const wire = await response.text();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode(wire));
              setTimeout(() => {
                controller.error(new Error("fake-private-transport-failure"));
              }, 5);
            },
          }),
          { headers: response.headers },
        );
      },
    });
    expect(result.actualHttpRequests).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.requests[0].captureInterrupted).toBe(true);
    expect(result.requests[0].rawUsage?.length).toBeGreaterThan(0);
    expect(
      result.requests[0].nativeSnapshots?.some(
        (item) =>
          item.event === "response.completed" && item.itemType === "reasoning",
      ),
    ).toBe(true);
    expect(result.modes[0].acceptedSteps).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("fake-private");
    expect(JSON.stringify(result)).not.toContain("fixture-encrypted");
  });

  it("stops on the first authentication failure and never reports secret error text", async () => {
    let requests = 0;
    const result = await runNativeProfile(NATIVE_REAL_PROFILES[0], {
      apiKey: "fake-sensitive-key",
      transport: () => {
        requests += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "unauthorized", message: "fake-sensitive-key" },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    expect(requests).toBe(1);
    expect(result.actualHttpRequests).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.modes).toHaveLength(1);
    expect(result.modes[0].acceptedSteps).toEqual([]);
    expect(result.modes[0].toolExecutions).toBe(0);
    expect(JSON.stringify(result)).not.toContain("fake-sensitive-key");
  });

  it.each(NATIVE_REAL_PROFILES)(
    "$id validates both modes with four bounded fake HTTP requests",
    async (profile) => {
      const result = await runNativeProfile(profile, {
        apiKey: "fake-local-key-never-reported",
        transport: nativeFixtureTransport(profile),
      });
      expect(
        result.modes.map((mode) => ({
          mode: mode.mode,
          failure: mode.failure,
        })),
      ).toEqual([
        { mode: "on", failure: undefined },
        { mode: "off", failure: undefined },
      ]);
      expect(result.passed).toBe(true);
      expect(result.actualHttpRequests).toBe(4);
      expect(result.modes[1].disabledEffect).toBe("zero_observed");
      if (profile.id === "zenmux-gpt56-luna-chat-native") {
        expect(
          result.requests.map((item) => item.controls.reasoning_effort),
        ).toEqual(["medium", "medium", "none", "none"]);
        expect(
          result.requests.every(
            (item) => item.controls.reasoning === undefined,
          ),
        ).toBe(true);
      }
      expect(result.testKnownCache).toEqual({
        accountedInputTokens: 20000,
        cacheReadTokens: 1200,
        cacheReadShare: 0.06,
      });
      expect(result.modes.map((mode) => mode.acceptedSteps.length)).toEqual([
        2, 2,
      ]);
      expect(
        result.modes.every(
          (mode) =>
            mode.databaseReopened &&
            mode.restoredTrackerEmpty &&
            mode.toolExecutions === 1,
        ),
      ).toBe(true);
      expect(result.modes[0].nativeReplayed).toBe(true);
      expect(result.modes[0].cacheBeforeReopen?.cacheReadShare).toBe(0.6);
      expect(result.modes[0].cacheAfterReopen?.cacheReadShare).toBe(0);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("fake-local-key");
      expect(serialized).not.toContain("fixture-encrypted");
      expect(serialized).not.toContain("fixture-signature");
      expect(serialized).not.toContain("Synthetic reasoning");
    },
  );
});
