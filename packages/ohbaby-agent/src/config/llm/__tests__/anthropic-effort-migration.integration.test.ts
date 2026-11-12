import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  modelProfileRouteKey,
  resolveRequestReasoning,
  type ReasoningCapabilities,
} from "ohbaby-llm";
import { toAnthropicReasoningWire } from "../../../../../ohbaby-llm/src/providers/reasoning.js";
import { createInProcessUiBackendClient } from "../../../adapters/ui-inprocess.js";
import {
  entryReasoningOptions,
  projectModelDocument,
  readModelDocument,
} from "../model-document.js";
import {
  createModelEntry,
  probeModelEntry,
  readModelSettings,
  updateModelEntry,
} from "../writer.js";
import { LLMConfigManager } from "../manager.js";

let root: string;
let options: { modelJsonPath: string; envPath: string };
const notice = "unsupported-anthropic-effort-cleared";
const route = {
  id: "adaptive",
  provider: "custom",
  model: "migration-adaptive",
  baseUrl: "https://migration.invalid/v1",
  interfaceProvider: "anthropic" as const,
};
const adaptive: ReasoningCapabilities = {
  mode: "effort",
  wire: "anthropic-adaptive",
  supportsDisabled: true,
  efforts: ["minimal", "high"],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anthropic-effort-migration-"));
  options = {
    modelJsonPath: join(root, "model.json"),
    envPath: join(root, ".env"),
  };
  vi.stubEnv("OHBABY_HOME", root);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  LLMConfigManager.resetInstance();
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: route.model,
              context_length: 128000,
              reasoning_capabilities: { ...adaptive, efforts: ["high"] },
            },
          ],
        }),
      ),
    ),
  );
});
afterEach(async () => {
  await vi.waitFor(async () => {
    const current = await readModelSettings(options);
    expect(
      current.models.every(
        (model) =>
          model.contextDiscovery.status !== "detecting" &&
          model.reasoning.status !== "detecting",
      ),
    ).toBe(true);
  });
  LLMConfigManager.resetInstance();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function writeDocument(
  version: 2 | undefined,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const raw = JSON.stringify({
    ...(version === undefined ? {} : { schemaVersion: version }),
    activeProfileId: route.id,
    models: [
      {
        ...route,
        contextWindowTokens: 128000,
        reasoningCapabilities: adaptive,
        reasoningCapabilitySource: "active-probe",
        detectedRouteKey: modelProfileRouteKey(route, route.provider),
        reasoning: { effort: "minimal" },
        ...extra,
      },
    ],
  });
  await writeFile(options.modelJsonPath, raw);
  return raw;
}

it.each([undefined, 2] as const)(
  "clears an incompatible default in memory for version %s, then persists it on normal Save",
  async (version) => {
    const raw = await writeDocument(version);
    const document = await readModelDocument(options);
    expect(document.models[0].reasoning).toBeUndefined();
    expect(document.models[0].reasoningCapabilities).toEqual(adaptive);
    expect(projectModelDocument(document)?.llmParams.reasoning).toBeUndefined();
    const current = (await readModelSettings(options)).models[0];
    expect(current).toMatchObject({
      reasoningNotice: notice,
      reasoning: { status: "identified", efforts: ["high"] },
    });
    expect(current.reasoningDefault).toBeUndefined();
    expect(await readFile(options.modelJsonPath, "utf8")).toBe(raw);
    await updateModelEntry(route.id, { label: "saved cleanup" }, options);
    const persisted = JSON.parse(
      await readFile(options.modelJsonPath, "utf8"),
    ) as { schemaVersion: number; models: Record<string, unknown>[] };
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.models[0]).not.toHaveProperty("reasoning");
    expect(persisted.models[0]).not.toHaveProperty("reasoningNotice");
    expect((await readModelSettings(options)).models[0].reasoningNotice).toBe(
      notice,
    );
    const freshPath = join(root, "fresh-load.json");
    await writeFile(freshPath, JSON.stringify(persisted));
    const fresh = (
      await readModelSettings({
        modelJsonPath: freshPath,
        envPath: options.envPath,
      })
    ).models[0];
    expect(fresh.reasoningDefault).toBeUndefined();
    expect(fresh.reasoningNotice).toBeUndefined();
  },
);

it("retains the cleanup notice through probe and failed selection, clears it after a successful explicit selection", async () => {
  await writeDocument(2);
  expect((await readModelSettings(options)).models[0].reasoningNotice).toBe(
    notice,
  );
  const workdir = join(root, "workspace");
  await mkdir(workdir);
  const client = createInProcessUiBackendClient({ workdir });
  try {
    expect(await client.getCurrentModel()).toMatchObject({
      reasoningNotice: notice,
      reasoning: { status: "identified", efforts: ["high"] },
    });
    await probeModelEntry(route.id, options);
    expect((await readModelSettings(options)).models[0].reasoningNotice).toBe(
      notice,
    );
    expect(
      (await readModelDocument(options)).models[0].reasoning,
    ).toBeUndefined();
    const beforeInvalid = await readFile(options.modelJsonPath, "utf8");
    await expect(
      updateModelEntry(route.id, { reasoning: { effort: "minimal" } }, options),
    ).rejects.toThrow(/minimal|unsupported/i);
    expect(await readFile(options.modelJsonPath, "utf8")).toBe(beforeInvalid);
    expect((await readModelSettings(options)).models[0].reasoningNotice).toBe(
      notice,
    );
    const saved = await updateModelEntry(
      route.id,
      { reasoning: { effort: "high" } },
      options,
    );
    expect(saved.models[0]).toMatchObject({
      reasoningDefault: { effort: "high" },
    });
    expect(saved.models[0].reasoningNotice).toBeUndefined();
    expect(
      (await readModelSettings(options)).models[0].reasoningNotice,
    ).toBeUndefined();
    expect((await client.getCurrentModel())?.reasoningNotice).toBeUndefined();
  } finally {
    await client.dispose();
  }
});

it("keeps minimal-only evidence readable and leaves unknown per-request intent on service default", async () => {
  await writeDocument(2, {
    reasoningCapabilities: { ...adaptive, efforts: ["minimal"] },
  });
  const document = await readModelDocument(options);
  expect(document.models[0].reasoning).toBeUndefined();
  expect((await readModelSettings(options)).models[0]).toMatchObject({
    reasoningNotice: notice,
    reasoning: { status: "unknown", efforts: [] },
  });
  const resolved = resolveRequestReasoning({
    ...entryReasoningOptions(document.models[0]),
    override: { effort: "minimal" },
  });
  expect(resolved.mode).toBe("service-default");
  expect(toAnthropicReasoningWire(resolved)).toEqual({});
});

it.each([
  {
    name: "explicit minimal-to-low map",
    capability: {
      ...adaptive,
      efforts: ["low", "high"],
      effortMap: { minimal: "low" },
    },
    wire: { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
  },
  {
    name: "budget effort",
    capability: {
      ...adaptive,
      wire: "anthropic-budget",
      efforts: ["minimal"],
      budgets: { minimal: 1024 },
    },
    wire: { thinking: { type: "enabled", budget_tokens: 1024 } },
  },
] as const)(
  "preserves a legal $name without cleanup",
  async ({ capability, wire }) => {
    await writeDocument(2, {
      reasoningCapabilities: capability,
      reasoningCapabilitySource: undefined,
      detectedRouteKey: undefined,
    });
    const document = await readModelDocument(options);
    expect(document.models[0].reasoning).toEqual({ effort: "minimal" });
    const view = (await readModelSettings(options)).models[0];
    expect(view.reasoningNotice).toBeUndefined();
    expect(view.reasoningDefault).toEqual({ effort: "minimal" });
    expect(
      toAnthropicReasoningWire(
        resolveRequestReasoning(entryReasoningOptions(document.models[0])),
      ),
    ).toEqual(wire);
    await updateModelEntry(
      route.id,
      { label: "legal preference retained" },
      options,
    );
    expect((await readModelDocument(options)).models[0].reasoning).toEqual({
      effort: "minimal",
    });
  },
);

it("rejects a newly created raw minimal preference instead of silently clearing it", async () => {
  await expect(
    createModelEntry(
      {
        provider: "anthropic",
        model: "claude-opus-4-6",
        baseUrl: "https://api.anthropic.com",
        interfaceProvider: "anthropic",
        reasoning: { effort: "minimal" },
      },
      options,
    ),
  ).rejects.toThrow(/minimal|unsupported/i);
  expect((await readModelSettings(options)).models).toEqual([]);
});

it.each([
  { preference: "minimal", capability: adaptive },
  {
    preference: "tiny",
    capability: { ...adaptive, effortMap: { tiny: "minimal" } },
  },
])(
  "preserves legacy top-level raw capability evidence while clearing $preference with a notice",
  async ({ preference, capability }) => {
    const raw = JSON.stringify({
      provider: route.provider,
      defaultModel: route.model,
      apiConfig: {
        baseUrl: route.baseUrl,
        interfaceProvider: route.interfaceProvider,
      },
      llmParams: { maxTokens: 8192, reasoning: { effort: preference } },
      models: [
        {
          ...route,
          contextWindowTokens: 128000,
          reasoningCapabilities: capability,
          reasoningCapabilitySource: "active-probe",
        },
      ],
    });
    await writeFile(options.modelJsonPath, raw);
    const document = await readModelDocument(options);
    expect(document.models[0].reasoningCapabilities).toEqual(capability);
    expect(document.models[0].reasoning).toBeUndefined();
    expect((await readModelSettings(options)).models[0]).toMatchObject({
      reasoningNotice: notice,
      reasoning: { status: "identified", efforts: ["high"] },
    });
    expect(await readFile(options.modelJsonPath, "utf8")).toBe(raw);
  },
);

it("emits the cleanup notice when new metadata first proves a saved minimal preference incompatible", async () => {
  await writeDocument(2, {
    reasoningCapabilities: undefined,
    reasoningCapabilitySource: undefined,
    detectedRouteKey: undefined,
  });
  const before = (await readModelSettings(options)).models[0];
  expect(before.reasoningDefault).toEqual({ effort: "minimal" });
  expect(before.reasoning.status).toBe("unknown");
  expect(before.reasoningNotice).toBeUndefined();
  await probeModelEntry(route.id, options);
  const after = (await readModelSettings(options)).models[0];
  expect(after.reasoningDefault).toBeUndefined();
  expect(after.reasoningNotice).toBe(notice);
  expect(after.reasoning).toMatchObject({
    status: "identified",
    efforts: ["high"],
  });
  const persisted = JSON.parse(
    await readFile(options.modelJsonPath, "utf8"),
  ) as { models: Record<string, unknown>[] };
  expect(persisted.models[0]).not.toHaveProperty("reasoning");
  expect(persisted.models[0]).not.toHaveProperty("reasoningNotice");
});

it("continues active probing when metadata has only unsendable minimal and recognizes high", async () => {
  await writeDocument(2, {
    reasoning: undefined,
    reasoningCapabilities: undefined,
    reasoningCapabilitySource: undefined,
    detectedRouteKey: undefined,
  });
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        if (typeof init.body !== "string")
          return Promise.reject(new Error("Expected JSON probe body"));
        const body = JSON.parse(init.body) as Record<string, unknown>;
        sent.push(body);
        const output = body.output_config as { effort?: string } | undefined;
        return Promise.resolve(
          new Response("{}", { status: output?.effort === "high" ? 200 : 400 }),
        );
      }
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: route.model,
              context_length: 128000,
              reasoning_capabilities: { ...adaptive, efforts: ["minimal"] },
            },
          ],
        }),
      );
    }),
  );
  await probeModelEntry(route.id, options);
  expect((await readModelSettings(options)).models[0].reasoning).toMatchObject({
    status: "identified",
    efforts: ["high"],
    source: "active-probe",
  });
  expect(sent).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ output_config: { effort: "high" } }),
    ]),
  );
  expect(
    sent.some(
      (body) =>
        (body.output_config as { effort?: string } | undefined)?.effort ===
        "minimal",
    ),
  ).toBe(false);
});

it("keeps an explicit minimal-only override unknown instead of replacing it with automatic high evidence", async () => {
  const explicit = { ...adaptive, efforts: ["minimal"] };
  await writeDocument(2, {
    reasoning: undefined,
    reasoningCapabilities: explicit,
    reasoningCapabilitySource: undefined,
    detectedRouteKey: undefined,
  });
  await probeModelEntry(route.id, options);
  expect((await readModelSettings(options)).models[0].reasoning).toMatchObject({
    status: "unknown",
    efforts: [],
  });
  const entry = (await readModelDocument(options)).models[0];
  expect(entry.reasoningCapabilities).toEqual(explicit);
  expect(entry.reasoningCapabilitySource).toBeUndefined();
});
