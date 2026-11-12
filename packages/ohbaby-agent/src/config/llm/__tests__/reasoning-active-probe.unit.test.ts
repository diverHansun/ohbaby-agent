/* eslint-disable @typescript-eslint/require-await -- Fetch fixtures implement the asynchronous fetch contract. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { resolveRequestReasoning } from "ohbaby-llm";
import { toChatReasoningWire } from "../../../../../ohbaby-llm/src/providers/reasoning.js";
import { probeReasoningCapabilities } from "../reasoning-active-probe.js";

const input = {
  apiKey: "fixture",
  baseUrl: "https://gateway.example/v1",
  interfaceProvider: "openai-compatible" as const,
  model: "exact-model",
  provider: "gateway",
};
interface Body {
  model: string;
  reasoning_effort?: string;
  reasoning?: { effort?: string; enabled?: boolean };
  thinking?: { type: string };
  output_config?: { effort: string };
  tools?: unknown[];
  max_tokens?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;
}
function strength(body: Body): string | undefined {
  return (
    body.reasoning_effort ??
    body.reasoning?.effort ??
    body.output_config?.effort
  );
}
function disabled(body: Body): boolean {
  return (
    strength(body) === "none" ||
    body.reasoning?.enabled === false ||
    body.thinking?.type === "disabled"
  );
}
function fixture(status: (body: Body) => number): Body[] {
  const bodies: Body[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Body;
    bodies.push(body);
    expect(init.redirect).toBe("manual");
    return new Response(null, { status: status(body) });
  });
  return bodies;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("uses Chat standard effort and the detected wire in real request resolution", async () => {
  const bodies = fixture((body) =>
    strength(body) === "medium" || strength(body) === "high" || disabled(body)
      ? 200
      : 422,
  );
  const result = await probeReasoningCapabilities(input);
  expect(result).toEqual({
    reasoningCapabilities: {
      mode: "effort",
      wire: "openai",
      supportsDisabled: true,
      efforts: ["medium", "high"],
    },
  });
  expect(bodies[0]?.reasoning_effort).toBe("ohbaby-invalid-effort");
  expect(bodies).toHaveLength(8);
  expect(bodies.every((body) => body.reasoning === undefined)).toBe(true);
  expect(
    bodies.every((body) => body.max_tokens === 32 && body.tools?.length === 1),
  ).toBe(true);
  expect(bodies[0]?.tools).toEqual([
    {
      type: "function",
      function: {
        name: "noop",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
  ]);
  const route = {
    ...input,
    maxTokens: 32768,
    modelProfiles: [
      {
        model: input.model,
        contextWindowTokens: 300000,
        reasoningCapabilities: result.reasoningCapabilities,
      },
    ],
  };
  expect(
    toChatReasoningWire(
      resolveRequestReasoning({ ...route, reasoning: { effort: "high" } }),
    ),
  ).toEqual({ reasoning_effort: "high" });
  expect(
    toChatReasoningWire(
      resolveRequestReasoning({ ...route, reasoning: { enabled: false } }),
    ),
  ).toEqual({ reasoning_effort: "none" });
});

it("returns unknown when Chat ignores reasoning_effort, without probing strengths", async () => {
  const bodies = fixture(() => 200);
  expect(await probeReasoningCapabilities(input)).toEqual({
    reasoningReason: "ignored-reasoning",
  });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.reasoning).toBeUndefined();
});

it.each(["openai-responses", "anthropic"] as const)(
  "uses bounded candidates and protocol-specific noop tools for %s",
  async (interfaceProvider) => {
    const bodies = fixture((body) =>
      strength(body) === "ohbaby-invalid-effort"
        ? 400
        : disabled(body)
          ? 422
          : 200,
    );
    const result = await probeReasoningCapabilities({
      ...input,
      interfaceProvider,
    });
    expect(result.reasoningCapabilities).toEqual({
      mode: "effort",
      wire: interfaceProvider === "anthropic" ? "anthropic-adaptive" : "openai",
      supportsDisabled: false,
      efforts:
        interfaceProvider === "anthropic"
          ? ["low", "medium", "high", "xhigh", "max"]
          : ["minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(bodies).toHaveLength(interfaceProvider === "anthropic" ? 7 : 8);
    expect(
      bodies.every(
        (body) =>
          (interfaceProvider === "anthropic"
            ? body.max_tokens
            : body.max_output_tokens) === 32,
      ),
    ).toBe(true);
    expect(bodies[0]?.tools).toEqual(
      interfaceProvider === "anthropic"
        ? [
            {
              name: "noop",
              input_schema: { type: "object", properties: {}, required: [] },
            },
          ]
        : [
            {
              type: "function",
              name: "noop",
              parameters: { type: "object", properties: {}, required: [] },
            },
          ],
    );
  },
);

it("uses native OpenAI's completion token cap", async () => {
  const bodies = fixture((body) => (strength(body) === "medium" ? 200 : 400));
  await probeReasoningCapabilities({
    ...input,
    baseUrl: "https://api.openai.com/v1/",
  });
  expect(
    bodies.every(
      (body) =>
        body.max_completion_tokens === 32 && body.max_tokens === undefined,
    ),
  ).toBe(true);
});

it("returns unknown after one request when official OpenAI ignores the invalid effort", async () => {
  const bodies = fixture(() => 200);
  expect(
    await probeReasoningCapabilities({
      ...input,
      baseUrl: "https://api.openai.com/v1/",
    }),
  ).toEqual({ reasoningReason: "ignored-reasoning" });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.reasoning_effort).toBe("ohbaby-invalid-effort");
  expect(bodies[0]?.reasoning).toBeUndefined();
});

it.each([302, 401, 403, 404, 408, 413, 429, 500])(
  "aborts the result on abnormal status %s at any phase",
  async (status) => {
    const reason =
      status === 401 || status === 403
        ? "authentication"
        : status === 429
          ? "rate-limit"
          : "http-error";
    const bodies = fixture(() => status);
    expect(await probeReasoningCapabilities(input)).toEqual({
      reasoningReason: reason,
    });
    expect(bodies).toHaveLength(1);
    fixture((body) =>
      strength(body) === "ohbaby-invalid-effort"
        ? 400
        : strength(body) === "high" || disabled(body)
          ? status
          : 200,
    );
    expect(await probeReasoningCapabilities(input)).toEqual({
      reasoningReason: reason,
    });
  },
);

it("reports unknown if no effort works with tools", async () => {
  fixture(() => 400);
  expect(await probeReasoningCapabilities(input)).toEqual({
    reasoningReason: "unsupported-efforts",
  });
});

it("bounds the whole probe including the control by one 60 second deadline", async () => {
  vi.useFakeTimers();
  let count = 0;
  vi.stubGlobal("fetch", async () => {
    count += 1;
    if (count === 1) {
      await new Promise((resolve) => setTimeout(resolve, 40_000));
      return new Response(null, { status: 400 });
    }
    return await new Promise<Response>(() => {
      /* Intentionally unresponsive transport. */
    });
  });
  const result = probeReasoningCapabilities(input);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(count).toBe(8);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toEqual({ reasoningReason: "timeout" });
});

it("returns cancellation and network reasons without exposing exception text", async () => {
  const controller = new AbortController();
  controller.abort(new Error("secret-key"));
  expect(
    await probeReasoningCapabilities({ ...input, signal: controller.signal }),
  ).toEqual({ reasoningReason: "cancelled" });
  vi.stubGlobal("fetch", async () => {
    throw new Error("secret-key");
  });
  expect(await probeReasoningCapabilities(input)).toEqual({
    reasoningReason: "network-error",
  });
});

async function httpFixture(
  work: (baseUrl: string, requests: Body[]) => Promise<void>,
  handle: (
    body: Body,
    req: IncomingMessage,
    res: ServerResponse,
    count: number,
  ) => void,
): Promise<void> {
  const requests: Body[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    req.on("end", () => {
      const body = JSON.parse(text || "{}") as Body;
      requests.push(body);
      handle(body, req, res, requests.length);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  try {
    await work(`http://127.0.0.1:${String(address.port)}/v1`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

it("dispatches every candidate and off concurrently after the control", async () => {
  const pending: ServerResponse[] = [];
  await httpFixture(
    async (baseUrl, requests) => {
      const result = await probeReasoningCapabilities({ ...input, baseUrl });
      expect(result.reasoningCapabilities?.efforts).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(result.reasoningCapabilities?.supportsDisabled).toBe(true);
      expect(requests).toHaveLength(8);
    },
    (body, _req, res) => {
      if (strength(body) === "ohbaby-invalid-effort") {
        res.writeHead(400).end();
        return;
      }
      pending.push(res);
      if (pending.length === 7)
        for (const response of pending) response.writeHead(200).end();
    },
  );
});

it("does not follow a real HTTP redirect", async () => {
  await httpFixture(
    async (baseUrl, requests) => {
      expect(await probeReasoningCapabilities({ ...input, baseUrl })).toEqual({
        reasoningReason: "http-error",
      });
      expect(requests).toHaveLength(1);
    },
    (_body, _req, res) => {
      res.writeHead(302, { Location: "/redirected" }).end();
    },
  );
});
