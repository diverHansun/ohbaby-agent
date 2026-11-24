/* eslint-disable @typescript-eslint/require-await -- Fetch fixtures expose controlled asynchronous responses. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeContextWindow } from "../context-window-probe.js";
const input = {
  apiKey: "fixture",
  baseUrl: "https://fixture.example/v1",
  interfaceProvider: "openai-compatible" as const,
  model: "exact",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("shared exact metadata discovery", () => {
  it("keeps reasoning:true incomplete and never uses similar model names", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: [
          {
            id: "exact-plus",
            reasoningCapabilities: {
              mode: "effort",
              wire: "openai",
              supportsDisabled: true,
              efforts: ["low", "medium"],
            },
          },
          { id: "exact", reasoning: true, context_length: 12345 },
        ],
      }),
    );
    const result = await probeContextWindow(input);
    expect(result.contextWindowTokens).toBe(12345);
    expect(result.reasoningCapabilities).toBeUndefined();
    expect(result.reasoningReason).toBe("missing-fields");
  });
  it("uses explicit capability metadata and follows pagination", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return Response.json(
        urls.length === 1
          ? { data: [{ id: "other" }], has_more: true, last_id: "other" }
          : {
              data: [
                {
                  id: "exact",
                  reasoning_capabilities: {
                    mode: "effort",
                    wire: "openai",
                    supportsDisabled: false,
                    efforts: ["high", "low"],
                  },
                },
              ],
            },
      );
    });
    const result = await probeContextWindow(input);
    expect(result.reasoningCapabilities?.efforts).toEqual(["high", "low"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("after=other");
  });
  const full = { mode: "binary", wire: "thinking", supportsDisabled: true };
  it.each([
    [
      {
        reasoning_levels: [" OFF ", null, {}, " Flash ", "Flash", "high"],
        supported_reasoning_levels: [{ effort: "other" }],
      },
      ["Flash", "high"],
    ],
    [
      {
        reasoning_levels: ["none", "DISABLED"],
        supported_reasoning_levels: [
          "wrong",
          {},
          { effort: " ULTra " },
          { effort: "off" },
        ],
      },
      ["ULTra"],
    ],
    [
      {
        reasoning_levels: ["minimal"],
        supported_reasoning_levels: [{ effort: "high" }],
      },
      ["minimal"],
    ],
  ] as const)(
    "reads the first usable catalog list in upstream order",
    async (fields, efforts) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({ data: [{ id: "exact", ...fields }] }),
      );
      expect(
        (await probeContextWindow({ ...input, interfaceProvider: "anthropic" }))
          .reasoningCapabilities,
      ).toEqual({
        mode: "effort",
        wire: "anthropic-adaptive",
        supportsDisabled: false,
        efforts,
        effortOrder: efforts,
      });
    },
  );
  it.each([
    [
      {
        reasoningCapabilities: full,
        reasoning: false,
        reasoning_levels: ["high"],
      },
      full,
    ],
    [
      {
        reasoningCapabilities: {},
        reasoning_capabilities: full,
        reasoning: false,
      },
      full,
    ],
    [
      {
        reasoningCapabilities: {},
        reasoning: false,
        reasoning_levels: ["high"],
      },
      { mode: "none", wire: "none", supportsDisabled: true },
    ],
    [
      {
        reasoning_levels: ["off", " "],
        supported_reasoning_levels: [null, "high"],
      },
      undefined,
    ],
  ] as const)(
    "respects explicit capabilities and absence of usable evidence",
    async (fields, expected) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({ data: [{ id: "exact", ...fields }] }),
      );
      expect((await probeContextWindow(input)).reasoningCapabilities).toEqual(
        expected,
      );
    },
  );
  it.each([
    ["openai", true],
    ["thinking", false],
  ] as const)(
    "keeps confirmed Off only for the same wire (%s)",
    async (wire, expected) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({ data: [{ id: "exact", reasoning_levels: ["high"] }] }),
      );
      const result = await probeContextWindow({
        ...input,
        previousReasoning: { mode: "binary", wire, supportsDisabled: true },
      });
      expect(result.reasoningCapabilities?.supportsDisabled).toBe(expected);
    },
  );
  it.each([
    [401, "authentication"],
    [429, "rate-limit"],
    [500, "http-error"],
  ])("classifies %s without throwing", async (status, reason) => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("error", { status: status }),
    );
    expect((await probeContextWindow(input)).reasoningReason).toBe(reason);
  });
  it("bounds body reading even after headers arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream()));
    const pending = probeContextWindow({ ...input, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect((await pending).reasoningReason).toBe("timeout");
  });
  it("classifies invalid JSON and cancellation", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad json"));
    expect((await probeContextWindow(input)).reasoningReason).toBe(
      "invalid-json",
    );
    expect(
      (await probeContextWindow({ ...input, signal: AbortSignal.abort() }))
        .reasoningReason,
    ).toBe("cancelled");
  });
});
