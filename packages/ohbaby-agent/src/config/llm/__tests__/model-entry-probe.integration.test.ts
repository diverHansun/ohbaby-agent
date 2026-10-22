import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as settings from "../writer.js";
import { readModelDocument } from "../model-document.js";
import { reloadLLMConfig, _LLMConfigManager } from "../index.js";
import {
  resolveRequestReasoning,
  type InterfaceProviderKind,
} from "ohbaby-llm";
import {
  toChatReasoningWire,
  toResponsesReasoningWire,
  toAnthropicReasoningWire,
} from "../../../../../ohbaby-llm/src/providers/reasoning.js";

let root: string;
let upstream: ReturnType<typeof createServer>;
let baseUrl: string;
let metadata: Record<string, unknown>;
let accepted: string[];
let ignoreControls: boolean;
let calls: { path: string; key: string; body: Record<string, unknown> }[];
let notices: number;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "entry-probe-"));
  vi.stubEnv("OHBABY_HOME", root);
  _LLMConfigManager.resetInstance();
  metadata = {};
  accepted = ["medium", "high"];
  ignoreControls = false;
  calls = [];
  notices = 0;
  upstream = createServer((req, res) => {
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "same", context_length: 64000, ...metadata }],
        }),
      );
      return;
    }
    void (async (): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      calls.push({
        path: req.url ?? "",
        key: String(req.headers.authorization ?? req.headers["x-api-key"]),
        body,
      });
      const reasoning = body.reasoning as
        | { effort?: string; enabled?: boolean }
        | undefined;
      const thinking = body.thinking as { type?: string } | undefined;
      const effort =
        (body.output_config as { effort?: string } | undefined)?.effort ??
        reasoning?.effort;
      res
        .writeHead(
          ignoreControls ||
            accepted.includes(effort ?? "") ||
            reasoning?.enabled === false ||
            reasoning?.effort === "none" ||
            thinking?.type === "disabled"
            ? 200
            : 400,
        )
        .end();
    })();
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  baseUrl = `http://127.0.0.1:${String((upstream.address() as { port: number }).port)}`;
});
afterEach(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) =>
    upstream.close(() => {
      resolve();
    }),
  );
  _LLMConfigManager.resetInstance();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const options = (): settings.ModelSettingsOptions => ({
  onDiscovery: (): void => {
    notices++;
  },
});
async function add(
  protocol: InterfaceProviderKind = "openai-compatible",
): Promise<import("ohbaby-sdk").UiSettingsModel> {
  const result = await settings.createModelEntry(
    {
      provider: "openai",
      model: "same",
      baseUrl: baseUrl + "/v1",
      interfaceProvider: protocol,
      apiKey: "target-key",
    },
    options(),
  );
  await vi.waitFor(() => {
    expect(notices).toBeGreaterThan(0);
  });
  return result.models[0];
}
it.each(["openai-compatible", "openai-responses", "anthropic"] as const)(
  "manual %s discovery persists only the target and normal loading uses the confirmed wire",
  async (protocol) => {
    const target = await add(protocol);
    expect(calls).toHaveLength(0);
    const view = await settings.probeModelEntry(target.id, options());
    expect(view).toMatchObject({
      status: "identified",
      source: "active-probe",
      efforts: ["medium", "high"],
    });
    const document = await readModelDocument();
    expect(document.activeProfileId).toBeUndefined();
    expect(document.models[0].reasoningCapabilities?.efforts).toEqual([
      "medium",
      "high",
    ]);
    const path =
      protocol === "anthropic"
        ? "/v1/messages"
        : protocol === "openai-responses"
          ? "/v1/responses"
          : "/v1/chat/completions";
    expect(calls).toHaveLength(8);
    expect(
      calls.every(
        (call) =>
          call.path === path &&
          call.key ===
            (protocol === "anthropic" ? "target-key" : "Bearer target-key"),
      ),
    ).toBe(true);
    expect(calls[0].body).toMatchObject(
      protocol === "anthropic"
        ? {
            thinking: { type: "adaptive" },
            output_config: { effort: "ohbaby-invalid-effort" },
            max_tokens: 32,
          }
        : protocol === "openai-responses"
          ? {
              reasoning: { effort: "ohbaby-invalid-effort" },
              max_output_tokens: 32,
            }
          : {
              reasoning: { enabled: true, effort: "ohbaby-invalid-effort" },
              max_tokens: 32,
            },
    );
    await settings.selectModelEntry(target.id);
    const config = await reloadLLMConfig({ projectDirectory: root });
    const resolved = resolveRequestReasoning(config);
    const wire =
      protocol === "anthropic"
        ? toAnthropicReasoningWire(resolved)
        : protocol === "openai-responses"
          ? toResponsesReasoningWire(resolved)
          : toChatReasoningWire(resolved);
    expect(wire).toMatchObject(
      protocol === "anthropic"
        ? {
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
          }
        : protocol === "openai-responses"
          ? { reasoning: { effort: "medium" } }
          : { reasoning: { enabled: true, effort: "medium" } },
    );
    expect(config.apiKey).toBe("target-key");
  },
);
it("fresh fallback replaces old automatic data, then fresh metadata stops probing and explicit overrides survive", async () => {
  const target = await add();
  await settings.probeModelEntry(target.id, options());
  accepted = ["low"];
  expect(await settings.probeModelEntry(target.id, options())).toMatchObject({
    efforts: ["low"],
    source: "active-probe",
  });
  metadata = { reasoning: false };
  calls = [];
  expect(await settings.probeModelEntry(target.id, options())).toMatchObject({
    mode: "none",
    source: "model-metadata",
  });
  expect(calls).toHaveLength(0);
  const document = await readModelDocument();
  document.models[0].reasoningCapabilities = {
    mode: "binary",
    wire: "thinking",
    supportsDisabled: false,
  };
  delete document.models[0].reasoningCapabilitySource;
  await writeFile(join(root, "model.json"), JSON.stringify(document));
  expect(await settings.probeModelEntry(target.id, options())).toMatchObject({
    mode: "binary",
    source: "local-model-profile",
  });
  expect(calls).toHaveLength(0);
});
it("an upstream accepting invalid controls leaves unknown and normal configuration uses service defaults", async () => {
  const target = await add();
  ignoreControls = true;
  expect(await settings.probeModelEntry(target.id, options())).toEqual({
    status: "unknown",
    efforts: [],
  });
  expect(calls).toHaveLength(1);
  await settings.selectModelEntry(target.id);
  expect(
    resolveRequestReasoning(await reloadLLMConfig({ projectDirectory: root }))
      .mode,
  ).toBe("service-default");
});
it("manual discovery of a candidate does not select it or change another entry", async () => {
  const target = await add();
  const other = (
    await settings.createModelEntry(
      {
        provider: "other",
        model: "other",
        baseUrl: baseUrl + "/v1",
        interfaceProvider: "openai-compatible",
        apiKeyEnv: null,
      },
      options(),
    )
  ).models[1];
  await settings.selectModelEntry(other.id);
  await settings.probeModelEntry(target.id, options());
  const document = await readModelDocument();
  expect(document.activeProfileId).toBe(other.id);
  expect(document.models.map((entry) => entry.id)).toEqual([
    target.id,
    other.id,
  ]);
  expect(document.models[1].reasoningCapabilities).toBeUndefined();
});

it("custom labels at official routes use builtins without any active probe", async () => {
  const methods: string[] = [];
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return Promise.resolve(
      Response.json({
        data: [{ id: "gpt-5.2", context_length: 128000, reasoning: false }],
      }),
    );
  });
  const target = (
    await settings.createModelEntry(
      {
        provider: "My official connection",
        model: "gpt-5.2",
        baseUrl: "https://api.openai.com/v1",
        interfaceProvider: "openai-responses",
        apiKeyEnv: null,
      },
      options(),
    )
  ).models[0];
  expect(await settings.probeModelEntry(target.id, options())).toMatchObject({
    status: "identified",
    source: "builtin:openai/gpt-5.2",
    efforts: ["low", "medium", "high", "xhigh"],
  });
  expect(methods.length).toBeGreaterThan(0);
  expect(methods.every((method) => method === "GET")).toBe(true);
});

it("fresh metadata replaces an older metadata result without active probing", async () => {
  metadata = { reasoning: false };
  const target = await add();
  metadata = {
    reasoning_capabilities: {
      mode: "effort",
      wire: "reasoning",
      supportsDisabled: true,
      efforts: ["low"],
    },
  };
  expect(await settings.probeModelEntry(target.id, options())).toMatchObject({
    status: "identified",
    mode: "effort",
    efforts: ["low"],
    source: "model-metadata",
  });
  expect(calls).toHaveLength(0);
});
