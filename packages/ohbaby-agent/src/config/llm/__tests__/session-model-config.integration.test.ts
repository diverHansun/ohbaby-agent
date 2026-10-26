import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelProfileRouteKey, resolveRequestReasoning } from "ohbaby-llm";
import {
  normalizeModelDocument,
  projectModelDocument,
  type ModelDocument,
} from "../model-document.js";
import {
  createModelEntry,
  selectModelEntry,
  updateModelEntry,
  writeModelEntryMetadata,
} from "../writer.js";
import { loadModelEntryConfig } from "../manager.js";

let dir: string;
let options: { modelJsonPath: string; envPath: string };
const route = {
  provider: "custom",
  model: "shared",
  baseUrl: "http://localhost:1/v1",
  interfaceProvider: "openai-compatible" as const,
  contextWindowTokens: 128000,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-model-config-"));
  vi.stubEnv("OHBABY_HOME", dir);
  options = {
    modelJsonPath: join(dir, "model.json"),
    envPath: join(dir, ".env"),
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it("migrates parameters per entry, preserves overrides, and projects the requested entry", () => {
  const document = normalizeModelDocument({
    activeProfileId: "a",
    llmParams: {
      maxTokens: 4000,
      temperature: 0.3,
      reasoning: { effort: "high" },
    },
    models: [
      { ...route, id: "a", maxOutputTokens: 5000 },
      { ...route, id: "b" },
    ],
  });
  expect(document).not.toHaveProperty("llmParams");
  expect(document.models[0]).toMatchObject({
    maxOutputTokens: 5000,
    temperature: 0.3,
    reasoning: { effort: "high" },
  });
  expect(document.models[1]).toMatchObject({ maxOutputTokens: 4000 });
  expect(document.models[1]).not.toHaveProperty("temperature");
  expect(document.models[1]).not.toHaveProperty("reasoning");
  expect(projectModelDocument(document, "b")?.llmParams).toEqual({
    maxTokens: 4000,
    contextWindowTokens: 128000,
  });
});
it("drops legacy reasoning incompatible with the original default", () => {
  const document = normalizeModelDocument({
    activeProfileId: "a",
    llmParams: { maxTokens: 4000, reasoning: { effort: "high" } },
    models: [
      {
        ...route,
        id: "a",
        reasoningCapabilities: {
          mode: "none",
          wire: "none",
          supportsDisabled: true,
        },
      },
    ],
  });
  expect(document.models[0]).not.toHaveProperty("reasoning");
});
it("backs up the original bytes only on the first migration write", async () => {
  const original = JSON.stringify(
    {
      provider: "custom",
      defaultModel: "shared",
      apiConfig: { baseUrl: route.baseUrl },
      llmParams: { maxTokens: 4000 },
    },
    null,
    3,
  );
  await writeFile(options.modelJsonPath, original);
  const first = await createModelEntry(route, options);
  const backups = await readdir(join(dir, "backups"));
  expect(backups).toHaveLength(1);
  expect(
    await readFile(join(dir, "backups", backups[0], "model.json"), "utf8"),
  ).toBe(original);
  expect(
    Object.keys(
      JSON.parse(await readFile(options.modelJsonPath, "utf8")) as Record<
        string,
        unknown
      >,
    ).sort(),
  ).toEqual(["activeProfileId", "models"]);
  await selectModelEntry(first.models[1].id, options);
  expect(await readdir(join(dir, "backups"))).toEqual(backups);
});
it("selects the first complete keyless entry and keeps entry reasoning across default changes", async () => {
  const a = await createModelEntry(
    { ...route, reasoning: { effort: "high" }, maxOutputTokens: 6000 },
    options,
  );
  expect(a.active?.id).toBe(a.models[0].id);
  expect(a).not.toHaveProperty("params");
  expect(a.models[0].reasoningDefault).toEqual({ effort: "high" });
  const b = await createModelEntry(route, options);
  const selected = await selectModelEntry(b.models[1].id, options);
  expect(selected.models[0].reasoningDefault).toEqual({ effort: "high" });
  const cleared = await updateModelEntry(
    a.models[0].id,
    { reasoning: null },
    options,
  );
  expect(cleared.models[0].reasoningDefault).toBeUndefined();
});
it("rejects explicit incompatible defaults and budgets equal to the output ceiling", async () => {
  const entry = {
    ...route,
    id: "a",
    interfaceProvider: "anthropic",
    reasoningCapabilities: {
      mode: "effort",
      wire: "anthropic-budget",
      efforts: ["high"],
      budgets: { high: 4096 },
      supportsDisabled: true,
    },
    maxOutputTokens: 4096,
  };
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({ activeProfileId: "a", models: [entry] }),
  );
  await expect(
    updateModelEntry("a", { reasoning: { effort: "high" } }, options),
  ).rejects.toThrow(/budget/iu);
  await expect(
    updateModelEntry("a", { reasoning: { effort: "xhigh" } }, options),
  ).rejects.toThrow(/effort/iu);
});

it.each([4096, 16384])(
  "revalidates discovered reasoning against the output ceiling %i",
  async (maxOutputTokens) => {
    const entry = {
      ...route,
      id: "a",
      interfaceProvider: "anthropic" as const,
      maxOutputTokens,
      reasoning: { effort: "high" as const },
    };
    await writeFile(
      options.modelJsonPath,
      JSON.stringify({ activeProfileId: "a", models: [entry] }),
    );
    const capability = {
      mode: "effort" as const,
      wire: "anthropic-budget" as const,
      efforts: ["low", "high"] as const,
      defaultEffort: "low" as const,
      budgets: { low: 1024, high: 8192 },
      supportsDisabled: true,
    };
    expect(
      await writeModelEntryMetadata(
        "a",
        {
          generation: 0,
          routeKey: modelProfileRouteKey(entry, entry.provider),
          contextWindowTokens: entry.contextWindowTokens,
        },
        {
          reasoningCapabilities: {
            ...capability,
            efforts: [...capability.efforts],
          },
        },
        options,
      ),
    ).toBe(true);
    const document = JSON.parse(
      await readFile(options.modelJsonPath, "utf8"),
    ) as ModelDocument;
    expect(document.models[0].reasoningCapabilities).toEqual(capability);
    expect(document.models[0].reasoning).toEqual(
      maxOutputTokens === 4096 ? undefined : { effort: "high" },
    );
    const config = await loadModelEntryConfig(options, "a");
    expect(() => resolveRequestReasoning(config)).not.toThrow();
  },
);

it("resolves explicit entries without a default and distinguishes removed from incomplete entries", async () => {
  const { resolveModelEntry } = await import("../model-document.js");
  const a = { ...route, id: "a" };
  const b = { ...route, id: "b", needsConfiguration: true };
  expect(resolveModelEntry({ models: [a] }, "a")).toEqual({
    entry: a,
    source: "explicit",
  });
  expect(
    resolveModelEntry({ activeProfileId: "a", models: [a] }, "deleted"),
  ).toEqual({ entry: a, source: "default", removedEntryId: "deleted" });
  expect(() =>
    resolveModelEntry({ activeProfileId: "a", models: [a, b] }, "b"),
  ).toThrow("Model configuration incomplete");
  expect(() => resolveModelEntry({ models: [a] })).toThrow(
    "No active model configured",
  );
});
it("loads independent entry parameters and fresh project credentials without replacing the default cache", async () => {
  const { loadModelEntryConfig, LLMConfigManager } =
    await import("../manager.js");
  const { mkdir } = await import("node:fs/promises");
  const left = join(dir, "left");
  const right = join(dir, "right");
  await mkdir(left);
  await mkdir(right);
  await writeFile(join(left, ".env"), "SESSION_MODEL_TEST_KEY=left-key\n");
  await writeFile(join(right, ".env"), "SESSION_MODEL_TEST_KEY=right-key\n");
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      activeProfileId: "a",
      models: [
        { ...route, id: "a", maxOutputTokens: 3000 },
        {
          ...route,
          id: "b",
          apiKeyEnv: "SESSION_MODEL_TEST_KEY",
          maxOutputTokens: 6000,
          temperature: 0.2,
        },
      ],
    }),
  );
  const manager = LLMConfigManager.getInstance();
  const cached = await manager.reload(options);
  const config = await loadModelEntryConfig(
    { modelJsonPath: options.modelJsonPath, projectDirectory: left, env: {} },
    "b",
  );
  expect(config).toMatchObject({
    apiKey: "left-key",
    maxTokens: 6000,
    temperature: 0.2,
  });
  expect(
    (
      await loadModelEntryConfig(
        {
          modelJsonPath: options.modelJsonPath,
          projectDirectory: right,
          env: {},
        },
        "b",
      )
    ).apiKey,
  ).toBe("right-key");
  await writeFile(join(left, ".env"), "SESSION_MODEL_TEST_KEY=changed-key\n");
  expect(
    (
      await loadModelEntryConfig(
        {
          modelJsonPath: options.modelJsonPath,
          projectDirectory: left,
          env: {},
        },
        "b",
      )
    ).apiKey,
  ).toBe("changed-key");
  expect(await manager.load(options)).toBe(cached);
});
it("only assigns automatic default when the selected entry is absent", async () => {
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      activeProfileId: "incomplete",
      models: [{ ...route, id: "incomplete", needsConfiguration: true }],
    }),
  );
  const added = await createModelEntry(route, options);
  expect(added.active?.id).toBe("incomplete");
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      activeProfileId: "deleted",
      models: [
        {
          id: "repair",
          provider: "custom",
          model: "shared",
          contextWindowTokens: 128000,
          needsConfiguration: true,
        },
      ],
    }),
  );
  const repaired = await updateModelEntry(
    "repair",
    { baseUrl: route.baseUrl, interfaceProvider: route.interfaceProvider },
    options,
  );
  expect(repaired.active?.id).toBe("repair");
});
it("backs up bytes read from the legacy home when publishing to the current home", async () => {
  const { mkdir } = await import("node:fs/promises");
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  const legacyHome = join(dir, ".ohbaby-agent");
  await mkdir(legacyHome);
  const original = JSON.stringify({
    provider: "old",
    defaultModel: "shared",
    apiConfig: { baseUrl: route.baseUrl },
    llmParams: { maxTokens: 3000 },
  });
  await writeFile(join(legacyHome, "model.json"), original);
  await createModelEntry(route);
  const backups = await readdir(join(dir, "backups"));
  expect(
    await readFile(join(dir, "backups", backups[0], "model.json"), "utf8"),
  ).toBe(original);
});
