/* eslint-disable @typescript-eslint/require-await -- Fetch fixtures implement the asynchronous fetch contract. */
import type { ModelJsonConfig } from "../types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { applyActiveModelConfig } from "../apply-active-model-config.js";
const dirs: string[] = [];
afterEach(async () => {
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
      reasoning?: { effort?: string; enabled?: boolean };
    };
    return new Response(null, {
      status:
        body.reasoning?.effort === "medium" || body.reasoning?.effort === "high"
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
    deferMetadata: true,
    onDiscovery: discovered,
  });
  expect(saved.saved).toBe(true);
  await done;
  const config = JSON.parse(
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
  expect(calls.some((url) => url.endsWith("/chat/completions"))).toBe(true);
});
it("reports saved without waiting for metadata and discards late previous-connection results", async () => {
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
    deferMetadata: true,
  };
  const saved = await Promise.race([
    applyActiveModelConfig({
      ...common,
      baseUrl: "https://route-a.example/v1",
      model: "a",
    }),
    new Promise<"blocked">((resolve) =>
      setTimeout(() => {
        resolve("blocked");
      }, 100),
    ),
  ]);
  expect(saved).not.toBe("blocked");
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  const config = JSON.parse(
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
  ).toBeUndefined();
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
    deferMetadata: true,
    onDiscovery: done,
  });
  await detected;
  expect(
    (
      JSON.parse(
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
    deferMetadata: true,
    onDiscovery: complete,
  });
  await done;
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
  expect(notifications).toBe(1);
  vi.stubGlobal("fetch", async () => new Response("limited", { status: 429 }));
  const stale = await probeActiveModelContextWindow(input);
  expect(stale.reasoning).toMatchObject({
    status: "identified",
    stale: true,
    reason: "rate-limit",
  });
  let backgroundDone!: () => void;
  const backgroundFinished = new Promise<void>((resolve) => {
    backgroundDone = resolve;
  });
  await applyActiveModelConfig({
    ...input,
    deferMetadata: true,
    onDiscovery: backgroundDone,
  });
  await backgroundFinished;
  const { currentDiscoveryState } =
    await import("../apply-active-model-config.js");
  expect(
    await currentDiscoveryState(input.modelJsonPath, input.envPath),
  ).toMatchObject({ status: "unknown", reason: "rate-limit" });
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
