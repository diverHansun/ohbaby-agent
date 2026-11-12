import { parseProjectedDocument } from "./model-document.test-support.js";
/* eslint-disable @typescript-eslint/require-await -- Fetch fixtures implement the asynchronous fetch contract. */
import type { ModelJsonConfig } from "ohbaby-llm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readModelDocument } from "../model-document.js";
import {
  applyActiveModelConfig,
  modelEntryDiscoveryState,
} from "../apply-active-model-config.js";
const dirs: string[] = [];
async function terminal(modelJsonPath: string, model?: string): Promise<void> {
  await vi.waitFor(async () => {
    const document = await readModelDocument({ modelJsonPath });
    for (const entry of document.models.filter(
      (entry) => model === undefined || entry.model === model,
    )) {
      const state = modelEntryDiscoveryState(entry.id, { modelJsonPath });
      expect(state?.context.status).not.toBe("detecting");
      expect(state?.reasoning.status).not.toBe("detecting");
    }
  });
}
afterEach(async () => {
  for (const root of dirs) await terminal(join(root, "model.json"));
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
it("discovers reasoning strengths in the background when model metadata only says reasoning is supported", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-active-"));
  dirs.push(root);
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push(path);
    if (path.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "exact",
            context_length: 64000,
            capabilities: { reasoning: true },
          },
        ],
      });
    const body = JSON.parse(init?.body as string) as {
      reasoning_effort?: string;
    };
    return new Response(null, {
      status:
        body.reasoning_effort === "medium" || body.reasoning_effort === "high"
          ? 200
          : 400,
    });
  });
  let discovered!: () => void;
  const done = new Promise<void>((resolve) => {
    discovered = resolve;
  });
  const saved = await applyActiveModelConfig({
    provider: "gateway",
    interfaceProvider: "openai-compatible",
    baseUrl: "https://gateway.example/v1",
    model: "exact",
    projectRoot: root,
    modelJsonPath: join(root, "model.json"),
    envPath: join(root, "env"),
    apiKey: "fixture",
    onDiscovery: discovered,
  });
  expect(saved.saved).toBe(true);
  await done;
  await terminal(join(root, "model.json"));
  const config = parseProjectedDocument(
    await readFile(join(root, "model.json"), "utf8"),
  ) as ModelJsonConfig;
  expect(
    config.models?.find((profile) => profile.model === "exact")
      ?.reasoningCapabilities,
  ).toMatchObject({
    mode: "effort",
    efforts: ["medium", "high"],
    supportsDisabled: false,
  });
  const { currentDiscoveryState } =
    await import("../apply-active-model-config.js");
  expect(
    await currentDiscoveryState(join(root, "model.json"), join(root, "env")),
  ).toEqual({ status: "identified" });
  expect(calls.some((url) => url.endsWith("/chat/completions"))).toBe(true);
});
it("reports saved without waiting and retains independent previous-entry results without selecting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-background-"));
  dirs.push(root);
  let answerA!: (r: Response) => void;
  vi.stubGlobal("fetch", (url: string) =>
    url.includes("route-a")
      ? new Promise<Response>((resolve) => {
          answerA = resolve;
        })
      : Promise.resolve(
          Response.json({
            data: [
              {
                id: "b",
                context_length: 32000,
                reasoning_capabilities: {
                  mode: "binary",
                  wire: "thinking",
                  supportsDisabled: false,
                },
              },
            ],
          }),
        ),
  );
  const common = {
    provider: "custom",
    interfaceProvider: "openai-compatible" as const,
    projectRoot: root,
    modelJsonPath: join(root, "model.json"),
    envPath: join(root, "env"),
  };
  const saved = await applyActiveModelConfig({
    ...common,
    baseUrl: "https://route-a.example/v1",
    model: "a",
  });
  expect(saved.saved).toBe(true);
  let discovered!: () => void;
  const done = new Promise<void>((resolve) => {
    discovered = resolve;
  });
  await applyActiveModelConfig({
    ...common,
    baseUrl: "https://route-b.example/v1",
    model: "b",
    onDiscovery: discovered,
  });
  await done;
  await terminal(common.modelJsonPath, "b");
  answerA(
    Response.json({
      data: [
        {
          id: "a",
          reasoning_capabilities: {
            mode: "effort",
            wire: "openai",
            supportsDisabled: true,
            efforts: ["high"],
          },
        },
      ],
    }),
  );
  await terminal(common.modelJsonPath, "a");
  const config = parseProjectedDocument(
    await readFile(common.modelJsonPath, "utf8"),
  ) as ModelJsonConfig;
  expect(config.defaultModel).toBe("b");
  expect(
    config.models?.find((p: { model: string }) => p.model === "b")
      ?.reasoningCapabilities?.mode,
  ).toBe("binary");
  expect(
    config.models?.find((p: { model: string }) => p.model === "a")
      ?.reasoningCapabilities,
  ).toMatchObject({ mode: "effort", efforts: ["high"] });
});
it("clears an incompatible persisted global intent after confirmed capability discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-reset-"));
  dirs.push(root);
  const common = {
    provider: "custom",
    interfaceProvider: "openai-compatible" as const,
    projectRoot: root,
    modelJsonPath: join(root, "model.json"),
    envPath: join(root, "env"),
    baseUrl: "https://fixture.example/v1",
    model: "binary",
  };
  vi.stubGlobal("fetch", async () =>
    Response.json({
      data: [
        {
          id: "binary",
          reasoning_capabilities: {
            mode: "binary",
            wire: "thinking",
            supportsDisabled: false,
          },
        },
      ],
    }),
  );
  let done!: () => void;
  const detected = new Promise<void>((resolve) => {
    done = resolve;
  });
  await applyActiveModelConfig({
    ...common,
    reasoning: { effort: "high" },
    onDiscovery: done,
  });
  await detected;
  await terminal(common.modelJsonPath);
  expect(
    (
      parseProjectedDocument(
        await readFile(common.modelJsonPath, "utf8"),
      ) as ModelJsonConfig
    ).llmParams.reasoning,
  ).toBeUndefined();
});
it("explicit retry publishes identified capability and preserves verified evidence after a temporary failure", async () => {
  const { probeActiveModelContextWindow } =
    await import("../apply-active-model-config.js");
  const root = await mkdtemp(join(tmpdir(), "reasoning-retry-"));
  dirs.push(root);
  const input = {
    provider: "custom",
    model: "m",
    baseUrl: "https://retry.example/v1",
    interfaceProvider: "openai-compatible" as const,
    projectRoot: root,
    modelJsonPath: join(root, "model.json"),
    envPath: join(root, "env"),
  };
  vi.stubGlobal("fetch", async () =>
    Response.json({ data: [{ id: "m", context_length: 32000 }] }),
  );
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  await applyActiveModelConfig({
    ...input,
    onDiscovery: complete,
  });
  await done;
  await terminal(input.modelJsonPath);
  vi.stubGlobal("fetch", async () =>
    Response.json({
      data: [
        {
          id: "m",
          reasoning_capabilities: {
            mode: "effort",
            wire: "openai",
            supportsDisabled: true,
            efforts: ["high", "low"],
          },
        },
      ],
    }),
  );
  let notifications = 0;
  const identified = await probeActiveModelContextWindow({
    ...input,
    onDiscovery: () => {
      notifications++;
    },
  });
  expect(identified.reasoning).toMatchObject({
    status: "identified",
    efforts: ["low", "high"],
    default: { effort: "low" },
  });
  expect(notifications).toBeGreaterThanOrEqual(3);
  vi.stubGlobal("fetch", async () => new Response("limited", { status: 429 }));
  const retried = await probeActiveModelContextWindow(input);
  expect(retried.reasoning).toMatchObject({
    status: "identified",
    reason: "rate-limit",
  });
  expect(retried.reasoning).not.toHaveProperty("stale");
  let backgroundDone!: () => void;
  const backgroundFinished = new Promise<void>((resolve) => {
    backgroundDone = resolve;
  });
  await applyActiveModelConfig({
    ...input,
    onDiscovery: backgroundDone,
  });
  await backgroundFinished;
  await terminal(input.modelJsonPath);
  const { currentDiscoveryState } =
    await import("../apply-active-model-config.js");
  expect(
    await currentDiscoveryState(input.modelJsonPath, input.envPath),
  ).toEqual({ status: "identified" });
  const persisted = JSON.parse(
    await readFile(input.modelJsonPath, "utf8"),
  ) as ModelJsonConfig;
  expect(persisted.models?.[0].reasoningCapabilities?.efforts).toEqual([
    "high",
    "low",
  ]);
});
it("retry public view respects an exact explicit profile over discovered metadata", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { probeActiveModelContextWindow } =
    await import("../apply-active-model-config.js");
  const root = await mkdtemp(join(tmpdir(), "reasoning-override-"));
  dirs.push(root);
  const input = {
    provider: "custom",
    model: "m",
    baseUrl: "https://override.example/v1",
    interfaceProvider: "openai-compatible" as const,
    projectRoot: root,
    modelJsonPath: join(root, "model.json"),
    envPath: join(root, "env"),
  };
  await writeFile(
    input.modelJsonPath,
    JSON.stringify({
      provider: input.provider,
      defaultModel: input.model,
      apiConfig: {
        baseUrl: input.baseUrl,
        interfaceProvider: input.interfaceProvider,
      },
      llmParams: { maxTokens: 4096 },
      models: [
        {
          model: "m",
          baseUrl: input.baseUrl,
          interfaceProvider: input.interfaceProvider,
          contextWindowTokens: 32000,
          reasoningCapabilities: {
            mode: "binary",
            wire: "thinking",
            supportsDisabled: false,
          },
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", async () =>
    Response.json({
      data: [
        {
          id: "m",
          reasoning_capabilities: {
            mode: "effort",
            wire: "openai",
            supportsDisabled: true,
            efforts: ["medium"],
          },
        },
      ],
    }),
  );
  const probe = await probeActiveModelContextWindow(input);
  expect(probe.reasoning).toMatchObject({
    mode: "binary",
    efforts: [],
    source: "local-model-profile",
  });
});
