import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModelEntry,
  updateModelEntry,
  deleteModelEntry,
  deleteModelProvider,
  selectModelEntry,
  readModelSettings,
  setActiveLLMConfig,
} from "../writer.js";
import { readModelDocument, projectModelDocument } from "../model-document.js";
import { updateSearchSettings } from "../../tools/search/writer.js";
let dir: string;
let opts: { modelJsonPath: string; envPath: string };
const route = {
  provider: "team/work",
  model: "vendor/shared",
  baseUrl: "http://localhost:1/v1",
  interfaceProvider: "openai-compatible" as const,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-settings-"));
  vi.stubEnv("OHBABY_HOME", dir);
  opts = { modelJsonPath: join(dir, "model.json"), envPath: join(dir, ".env") };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
async function disk(): Promise<import("../model-document.js").ModelDocument> {
  return readModelDocument(opts);
}
async function add(fields = {}): Promise<import("ohbaby-sdk").UiSettingsModel> {
  const result = await createModelEntry({ ...route, ...fields }, opts);
  const entry = result.models.at(-1);
  if (!entry) throw new Error("Missing saved entry");
  return entry;
}
describe("independent model settings", () => {
  it("appends identical routes without deduplication and keeps the first default and persists defaults", async () => {
    const a = await add({ apiKey: "secret-a", label: "Work" });
    const b = await add({ apiKey: "secret-b" });
    expect(a.id).not.toBe(b.id);
    expect(a.apiKeyEnv).not.toBe(b.apiKeyEnv);
    expect((await readModelSettings(opts)).active?.id).toBe(a.id);
    expect((await disk()).models.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(a.contextWindowTokens).toBe(128000);
    expect(JSON.stringify(await readModelSettings(opts))).not.toMatch(
      /secret-a|secret-b/,
    );
  });
  it("redacts base URLs only with referenced model keys, not unrelated short env values", async () => {
    await writeFile(opts.envPath, "PORT=8080\nDEBUG=1\n");
    const plain = await add({
      baseUrl: "http://localhost:8080/v1",
      apiKey: "secret-path-value",
    });
    expect(plain.baseUrl).toBe("http://localhost:8080/v1");
    const leaky = await add({
      baseUrl: "http://localhost:9/v1/leaky-path-secret",
      apiKey: "leaky-path-secret",
    });
    expect(leaky.baseUrl).not.toContain("leaky-path-secret");
    expect(
      (await readModelSettings(opts)).models.find((e) => e.id === plain.id)
        ?.baseUrl,
    ).toBe("http://localhost:8080/v1");
  });
  it("edits only the target and preserves id, order, active snapshot and global preferences", async () => {
    const a = await add({ label: "A" });
    const b = await add({ label: "B" });
    await selectModelEntry(a.id, opts);
    const before = await disk();
    before.models[0].temperature = 0.3;
    before.models[0].maxOutputTokens = 1234;
    before.models[0].reasoning = { enabled: true, effort: "high" };
    await writeFile(opts.modelJsonPath, JSON.stringify(before));
    await updateModelEntry(
      b.id,
      {
        provider: "other",
        model: "other/name",
        interfaceProvider: "anthropic",
        contextWindowTokens: 50000,
        label: null,
      },
      opts,
    );
    const next = await disk();
    expect(next.activeProfileId).toBe(a.id);
    expect(next.models[0]).toEqual(before.models[0]);
    expect(next.models[0]).toEqual(before.models[0]);
    expect(next.models.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(next.models[1].label).toBeUndefined();
    await selectModelEntry(b.id, opts);
    expect(
      projectModelDocument(await disk())?.apiConfig.interfaceProvider,
    ).toBe("anthropic");
    expect((await disk()).models[0].reasoning).toEqual(
      before.models[0].reasoning,
    );
  });
  it("isolates replacement from shared model and legacy search references and detaches on clear", async () => {
    await writeFile(opts.envPath, "TAVILY_API_KEY=original\n");
    const a = await add({ apiKeyEnv: "TAVILY_API_KEY" });
    const b = await add({ apiKeyEnv: "TAVILY_API_KEY" });
    await selectModelEntry(a.id, opts);
    await updateModelEntry(a.id, { apiKey: "new-secret" }, opts);
    let current = await disk();
    expect(current.models[0].apiKeyEnv).not.toBe("TAVILY_API_KEY");
    expect(current.models[1].apiKeyEnv).toBe("TAVILY_API_KEY");
    expect(await readFile(opts.envPath, "utf8")).toContain(
      "TAVILY_API_KEY=original",
    );
    await updateModelEntry(b.id, { apiKey: "" }, opts);
    current = await disk();
    expect(current.models[1].apiKeyEnv).toBeUndefined();
    expect(await readFile(opts.envPath, "utf8")).toContain(
      "TAVILY_API_KEY=original",
    );
  });
  it("legacy connect updates the first normalized endpoint match ignoring protocol and keeps siblings", async () => {
    const a = await add({ label: "keep" });
    const b = await add({ interfaceProvider: "anthropic" });
    await setActiveLLMConfig({
      ...route,
      baseUrl: route.baseUrl + "/",
      interfaceProvider: "openai-responses",
      apiKey: "connected",
      ...opts,
    });
    const next = await disk();
    expect(next.activeProfileId).toBe(a.id);
    expect(next.models.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(next.models[0].interfaceProvider).toBe("openai-responses");
    expect(next.models[0].label).toBe("keep");
    expect(next.models[1].interfaceProvider).toBe("anthropic");
  });
  it("deletes a whole provider, advances through original interleaved order and retains every key", async () => {
    const a = await add({ apiKey: "retained-a" });
    const b = await add({ provider: "other", apiKey: "retained-b" });
    const c = await add();
    const d = await add({ provider: "other" });
    await selectModelEntry(c.id, opts);
    const env = await readFile(opts.envPath, "utf8");
    await deleteModelProvider(route.provider, opts);
    expect((await disk()).models.map((e) => e.id)).toEqual([b.id, d.id]);
    expect((await disk()).activeProfileId).toBe(d.id);
    await deleteModelEntry(d.id, opts);
    expect((await disk()).activeProfileId).toBe(b.id);
    await deleteModelEntry(b.id, opts);
    const empty = await disk();
    expect(projectModelDocument(empty)).toBeNull();
    expect(projectModelDocument(empty)).toBeNull();
    expect(await readFile(opts.envPath, "utf8")).toBe(env);
    await expect(deleteModelEntry(a.id, opts)).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
  });
  it("reads legacy ids stably without writing and requires explicit completion before selecting history", async () => {
    const original = JSON.stringify({
      provider: "old",
      defaultModel: "current",
      apiConfig: { baseUrl: route.baseUrl },
      llmParams: { maxTokens: 5000 },
      models: [
        { id: "same", model: "historical", contextWindowTokens: 20000 },
        { id: "same", model: "current", contextWindowTokens: 40000 },
      ],
    });
    await writeFile(opts.modelJsonPath, original);
    const first = await readModelSettings(opts);
    expect(await readModelSettings(opts)).toEqual(first);
    expect(await readFile(opts.modelJsonPath, "utf8")).toBe(original);
    expect(first.models[0].configurationComplete).toBe(false);
    await expect(
      selectModelEntry(first.models[0].id, opts),
    ).rejects.toMatchObject({ code: "MODEL_CONFIG_INCOMPLETE" });
    await updateModelEntry(
      first.models[0].id,
      {
        baseUrl: route.baseUrl,
        interfaceProvider: "openai-compatible",
        apiKeyEnv: null,
      },
      opts,
    );
    await selectModelEntry(first.models[0].id, opts);
    expect((await disk()).activeProfileId).toBe(first.models[0].id);
  });
  it("serializes model and search secret writes without losing either secret", async () => {
    await Promise.all([
      add({ apiKey: "model-secret" }),
      updateSearchSettings({ apiKey: "search-secret" }),
    ]);
    const env = await readFile(opts.envPath, "utf8");
    expect(env).toContain("model-secret");
    expect(env).toContain("search-secret");
  });
  it("rejects illegal references and local fields without persisting secrets or creating entries", async () => {
    await expect(
      add({ apiKeyEnv: "BAD-NAME", apiKey: "never-persist" }),
    ).rejects.toThrow();
    await expect(add({ contextWindowTokens: 0 })).rejects.toThrow();
    expect((await disk()).models).toEqual([]);
  });
});

it("does not let cached manager loads reuse a deleted model and selects a new first complete entry", async () => {
  const { LLMConfigManager } = await import("../manager.js");
  LLMConfigManager.resetInstance();
  const a = await add();
  await selectModelEntry(a.id, opts);
  const manager = LLMConfigManager.getInstance();
  await manager.load(opts);
  await deleteModelEntry(a.id, opts);
  await expect(manager.load(opts)).rejects.toMatchObject({
    code: "FILE_NOT_FOUND",
  });
  await add();
  expect((await manager.load(opts)).model).toBe(route.model);
});
it("default first write migrates the effective legacy file, explicit missing paths remain isolated", async () => {
  const { mkdir } = await import("node:fs/promises");
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  const legacy = join(dir, ".ohbaby-agent", "model.json");
  await mkdir(join(dir, ".ohbaby-agent"));
  await writeFile(
    legacy,
    JSON.stringify({
      provider: "legacy",
      defaultModel: "old",
      apiConfig: { baseUrl: route.baseUrl },
      llmParams: { maxTokens: 4321, temperature: 0.5 },
    }),
  );
  const before = await readModelSettings();
  expect(before.active?.model).toBe("old");
  await createModelEntry(route);
  const after = await readModelSettings();
  expect(after.active).toEqual(before.active);
  expect(after.models.map((e) => e.model)).toEqual(["old", route.model]);
  expect(after.models[0].maxOutputTokens).toBe(4321);
  const explicit = {
    modelJsonPath: join(dir, "isolated", "model.json"),
    envPath: join(dir, "isolated", ".env"),
  };
  await createModelEntry(route, explicit);
  const isolated = await readModelSettings(explicit);
  expect(isolated.active?.id).toBe(isolated.models[0].id);
  expect(isolated.models).toHaveLength(1);
});
it("deleting the active model skips incomplete history, wraps and preserves global preferences", async () => {
  const a = await add();
  const b = await add({ provider: "other" });
  const document = await disk();
  document.models.splice(1, 0, {
    id: "incomplete",
    provider: "old",
    model: "old",
    contextWindowTokens: 20000,
    needsConfiguration: true,
  });
  document.models[0].temperature = 0.4;
  await writeFile(opts.modelJsonPath, JSON.stringify(document));
  await selectModelEntry(a.id, opts);
  await deleteModelEntry(a.id, opts);
  expect((await disk()).activeProfileId).toBe(b.id);
  await deleteModelEntry(b.id, opts);
  const last = await disk();
  expect(last.activeProfileId).toBeUndefined();
  expect(last.models.map((e) => e.id)).toEqual(["incomplete"]);
  expect(last.models[0].temperature).toBeUndefined();
});

it("a failed model secret write rolls back before a queued search save, preserving that successful save", async () => {
  const secrets = await import("../../secrets/env-secrets.js");
  const a = await add({ apiKeyEnv: "SHARED_TEST", apiKey: "original-model" });
  const original = await readFile(opts.modelJsonPath, "utf8");
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(secrets, "writeEnvSecret")
    .mockImplementationOnce(async () => {
      entered();
      await gate;
      throw new Error("controlled secret failure");
    });
  try {
    const failed = updateModelEntry(
      a.id,
      { apiKey: "failed-model" },
      opts,
    ).catch((error: unknown) => error);
    await waiting;
    const search = updateSearchSettings({ apiKey: "successful-search" });
    release();
    expect(await failed).toBeInstanceOf(Error);
    await search;
    expect(await readFile(opts.modelJsonPath, "utf8")).toBe(original);
    const env = await readFile(opts.envPath, "utf8");
    expect(env).toContain("original-model");
    expect(env).toContain("successful-search");
    expect(env).not.toContain("failed-model");
  } finally {
    release();
    spy.mockRestore();
  }
});
it("legacy connect isolates a shared key before replacement and preserves the selected entry on omitted key", async () => {
  const a = await add({ apiKeyEnv: "SHARED_CONNECT", apiKey: "original" });
  const b = await add({ apiKeyEnv: "SHARED_CONNECT" });
  await setActiveLLMConfig({ ...route, ...opts, apiKey: "replacement" });
  let document = await disk();
  expect(document.activeProfileId).toBe(a.id);
  expect(document.models[0].apiKeyEnv).not.toBe("SHARED_CONNECT");
  expect(document.models[1].apiKeyEnv).toBe("SHARED_CONNECT");
  const reference = document.models[0].apiKeyEnv;
  await setActiveLLMConfig({ ...route, ...opts });
  document = await disk();
  expect(document.models[0].apiKeyEnv).toBe(reference);
  expect(document.models[1].id).toBe(b.id);
  const env = await readFile(opts.envPath, "utf8");
  expect(env).toContain("SHARED_CONNECT=original");
  expect(env).toContain(`${String(reference)}=replacement`);
});
it("search replacement cannot overwrite a model's shared key and explicit null detaches an external shell reference", async () => {
  vi.stubEnv("EXTERNAL_TEST_KEY", "external-value");
  const a = await add({ apiKeyEnv: "EXTERNAL_TEST_KEY" });
  expect(a.apiKeyConfigured).toBe(true);
  await updateModelEntry(a.id, { apiKeyEnv: null }, opts);
  expect((await readModelSettings(opts)).models[0].apiKeyConfigured).toBe(
    false,
  );
  expect(process.env.EXTERNAL_TEST_KEY).toBe("external-value");
  await writeFile(opts.envPath, "TAVILY_API_KEY=model-shared-value\n");
  const b = await add({ apiKeyEnv: "TAVILY_API_KEY" });
  const search = await updateSearchSettings({ apiKey: "new-search-value" });
  expect(search.apiKeyEnv).not.toBe("TAVILY_API_KEY");
  expect(
    (await readModelSettings(opts)).models.find((e) => e.id === b.id)
      ?.apiKeyEnv,
  ).toBe("TAVILY_API_KEY");
  expect(await readFile(opts.envPath, "utf8")).toContain(
    "TAVILY_API_KEY=model-shared-value",
  );
});

it("legacy connect preserves query/fragment endpoint identity instead of trimming meaningful trailing separators", async () => {
  const { applyActiveModelConfig } =
    await import("../apply-active-model-config.js");
  const endpoint = route.baseUrl + "?route=/";
  const a = await add({ baseUrl: endpoint });
  await applyActiveModelConfig({
    ...route,
    ...opts,
    baseUrl: endpoint,
    projectRoot: dir,
    deferMetadata: true,
  });
  const document = await disk();
  expect(document.models).toHaveLength(1);
  expect(document.activeProfileId).toBe(a.id);
  expect(projectModelDocument(document)?.apiConfig.baseUrl).toBe(endpoint);
});
it("validates inactive document parameters and active-id shape instead of silently accepting malformed files", async () => {
  await writeFile(
    opts.modelJsonPath,
    JSON.stringify({ models: [], llmParams: { maxTokens: 0 } }),
  );
  await expect(readModelSettings(opts)).rejects.toThrow();
  await writeFile(
    opts.modelJsonPath,
    JSON.stringify({
      activeProfileId: 17,
      models: [],
      llmParams: { maxTokens: 8192 },
    }),
  );
  await expect(readModelSettings(opts)).rejects.toThrow();
});

it.each([
  ["select", "none"],
  ["select", "binary"],
  ["delete-entry", "none"],
  ["delete-entry", "binary"],
  ["delete-provider", "none"],
  ["delete-provider", "binary"],
] as const)(
  "%s immediately adapts old reasoning effort to the known %s successor",
  async (operation, mode) => {
    await writeFile(
      opts.modelJsonPath,
      JSON.stringify({
        activeProfileId: "a",
        provider: "a",
        defaultModel: "a",
        apiConfig: {
          baseUrl: route.baseUrl,
          interfaceProvider: route.interfaceProvider,
        },
        llmParams: {
          maxTokens: 8192,
          reasoning: { enabled: true, effort: "high" },
        },
        models: [
          {
            ...route,
            id: "a",
            provider: "a",
            model: "a",
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "effort",
              wire: "reasoning",
              efforts: ["high"],
              supportsDisabled: true,
            },
          },
          {
            ...route,
            id: "b",
            provider: "b",
            model: "b",
            contextWindowTokens: 64000,
            reasoningCapabilities: {
              mode,
              wire: mode === "none" ? "none" : "thinking",
              supportsDisabled: true,
            },
          },
        ],
      }),
    );
    if (operation === "select") await selectModelEntry("b", opts);
    else if (operation === "delete-entry") await deleteModelEntry("a", opts);
    else await deleteModelProvider("a", opts);
    const { reloadLLMConfig } = await import("../index.js");
    const { resolveRequestReasoning } = await import("ohbaby-llm");
    const config = await reloadLLMConfig({ ...opts, projectDirectory: dir });
    expect(config.model).toBe("b");
    expect(resolveRequestReasoning(config).mode).toBe(mode);
    expect(
      (await disk()).models.find((entry) => entry.id === "b")?.reasoning,
    ).toBeUndefined();
  },
);

it("patching the current official model immediately clears an incompatible effort while candidate PATCH preserves it", async () => {
  let metadataRequests = 0;
  vi.stubGlobal("fetch", () => {
    metadataRequests++;
    return Promise.resolve(Response.json({ data: [] }));
  });
  try {
    await writeFile(
      opts.modelJsonPath,
      JSON.stringify({
        activeProfileId: "current",
        provider: "My official upstream",
        defaultModel: "gpt-5.2",
        apiConfig: {
          baseUrl: "https://api.openai.com/v1",
          interfaceProvider: "openai-responses",
        },
        llmParams: {
          maxTokens: 8192,
          reasoning: { enabled: true, effort: "high" },
        },
        models: ["current", "candidate"].map((id) => ({
          id,
          provider: "My official upstream",
          model: "gpt-5.2",
          baseUrl: "https://api.openai.com/v1",
          interfaceProvider: "openai-responses",
          contextWindowTokens: 128000,
        })),
      }),
    );
    const { reloadLLMConfig } = await import("../index.js");
    const { resolveRequestReasoning } = await import("ohbaby-llm");
    const load = (): ReturnType<typeof reloadLLMConfig> =>
      reloadLLMConfig({ ...opts, projectDirectory: dir });
    expect(resolveRequestReasoning(await load()).effort).toBe("high");
    await updateModelEntry("candidate", { model: "gpt-4o" }, opts);
    expect((await disk()).models[0].reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
    expect(resolveRequestReasoning(await load()).effort).toBe("high");
    await updateModelEntry("current", { model: "gpt-4o" }, opts);
    const config = await load();
    expect(config.model).toBe("gpt-4o");
    expect(resolveRequestReasoning(config).mode).toBe("none");
    expect((await disk()).models[0].reasoning).toBeUndefined();
  } finally {
    await vi.waitFor(() => {
      expect(metadataRequests).toBe(2);
    });
    vi.unstubAllGlobals();
  }
});
