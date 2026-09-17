/* eslint-disable @typescript-eslint/require-await -- Fetch fixtures implement the asynchronous fetch contract. */
import { afterEach, expect, it, vi } from "vitest";
import { probeReasoningCapabilities } from "../reasoning-active-probe.js";

const input = {
  apiKey: "fixture",
  baseUrl: "https://gateway.example/v1",
  interfaceProvider: "openai-compatible" as const,
  model: "exact-model",
  provider: "gateway",
};

afterEach(() => vi.unstubAllGlobals());

it("identifies only strengths accepted by the exact Chat model after a rejected invalid control", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    requests.push(body);
    const reasoning = body.reasoning as { effort?: string; enabled?: boolean };
    return new Response(null, {
      status:
        reasoning.effort === "high" ||
        reasoning.effort === "medium" ||
        reasoning.enabled === false
          ? 200
          : 400,
    });
  });
  expect(await probeReasoningCapabilities(input)).toEqual({
    mode: "effort",
    wire: "reasoning",
    supportsDisabled: true,
    efforts: ["medium", "high"],
  });
  expect(requests.every((request) => request.model === "exact-model")).toBe(
    true,
  );
  expect(
    requests.some(
      (request) =>
        (request.reasoning as { effort?: string }).effort ===
        "ohbaby-invalid-effort",
    ),
  ).toBe(true);
});

it("does not invent strengths when the provider silently accepts an invalid control", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
  expect(await probeReasoningCapabilities(input)).toBeUndefined();
});

it("uses protocol-specific Responses requests and never infers disabled without a successful request", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(init.body as string) as {
      reasoning: { effort: string };
    };
    return new Response(null, {
      status:
        body.reasoning.effort === "medium" || body.reasoning.effort === "low"
          ? 200
          : 400,
    });
  });
  expect(
    await probeReasoningCapabilities({
      ...input,
      interfaceProvider: "openai-responses",
    }),
  ).toEqual({
    mode: "effort",
    wire: "openai",
    supportsDisabled: false,
    efforts: ["low", "medium"],
  });
  expect(urls.every((url) => url.endsWith("/responses"))).toBe(true);
});

it("uses the Anthropic messages route and adaptive effort fields", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(init.body as string) as {
      output_config?: { effort: string };
    };
    return new Response(null, {
      status: body.output_config?.effort === "high" ? 200 : 400,
    });
  });
  expect(
    await probeReasoningCapabilities({
      ...input,
      baseUrl: "https://gateway.example/api/anthropic",
      interfaceProvider: "anthropic",
    }),
  ).toEqual({
    mode: "effort",
    wire: "anthropic-adaptive",
    supportsDisabled: false,
    efforts: ["high"],
  });
  expect(urls[0]).toBe("https://gateway.example/api/anthropic/v1/messages");
});

it("uses Chat reasoning_effort and max_completion_tokens for native OpenAI models", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string | URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    requests.push(body);
    return new Response(null, {
      status:
        body.reasoning_effort === "medium" || body.reasoning_effort === "none"
          ? 200
          : 400,
    });
  });
  expect(
    await probeReasoningCapabilities({ ...input, provider: "openai" }),
  ).toEqual({
    mode: "effort",
    wire: "openai",
    supportsDisabled: true,
    efforts: ["medium"],
  });
  expect(
    requests.every(
      (body) =>
        body.max_completion_tokens === 32 && body.max_tokens === undefined,
    ),
  ).toBe(true);
});
