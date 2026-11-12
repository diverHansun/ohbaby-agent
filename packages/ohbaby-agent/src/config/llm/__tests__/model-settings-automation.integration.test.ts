import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readModelDocument,
  projectModelDocument,
  type ModelDocument,
} from "../model-document.js";
import {
  createModelEntry,
  readModelSettings,
  updateModelEntry,
  writeModelEntryMetadata,
  modelEntryGeneration,
} from "../writer.js";
let dir: string;
let options: { modelJsonPath: string; envPath: string };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-settings-automation-"));
  options = {
    modelJsonPath: join(dir, "model.json"),
    envPath: join(dir, ".env"),
  };
  vi.stubEnv("OHBABY_HOME", dir);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 404 }))),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const route = {
  id: "one",
  provider: "custom",
  model: "unknown",
  baseUrl: "https://model.example/v1",
  interfaceProvider: "openai-compatible",
};
it("keeps new numeric intent empty while projecting usable runtime limits", async () => {
  const settings = await createModelEntry(
    {
      provider: "custom",
      model: "unknown",
      baseUrl: route.baseUrl,
      interfaceProvider: "openai-compatible",
      apiKeyEnv: "MISSING_AUTOMATION_KEY",
    },
    options,
  );
  expect(settings.models[0]).toMatchObject({
    effectiveContextWindowTokens: 300000,
    effectiveMaxOutputTokens: 32768,
  });
  expect(settings.models[0].contextWindowTokens).toBeUndefined();
  expect(settings.models[0].maxOutputTokens).toBeUndefined();
  const raw = JSON.parse(
    await readFile(options.modelJsonPath, "utf8"),
  ) as ModelDocument;
  expect(raw.schemaVersion).toBe(2);
  expect(raw.models[0].contextWindowTokens).toBeUndefined();
  expect(raw.models[0].maxOutputTokens).toBeUndefined();
  expect(
    projectModelDocument(await readModelDocument(options))?.llmParams,
  ).toMatchObject({ maxTokens: 32768, contextWindowTokens: 300000 });
});
it("migrates old defaults once and preserves a later intentional 8192 override", async () => {
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      activeProfileId: "one",
      models: [
        { ...route, contextWindowTokens: 128000, maxOutputTokens: 8192 },
      ],
    }),
  );
  const migrated = await readModelSettings(options);
  expect(migrated.models[0]).toMatchObject({
    detectedContextWindowTokens: 128000,
    effectiveContextWindowTokens: 128000,
    effectiveMaxOutputTokens: 32768,
  });
  expect(migrated.models[0].contextWindowTokens).toBeUndefined();
  await updateModelEntry("one", { maxOutputTokens: 8192 }, options);
  expect((await readModelSettings(options)).models[0].maxOutputTokens).toBe(
    8192,
  );
  const raw = JSON.parse(
    await readFile(options.modelJsonPath, "utf8"),
  ) as ModelDocument;
  expect(raw.schemaVersion).toBe(2);
  expect(raw.models[0].detectedRouteKey).toBe(
    JSON.stringify([
      route.provider,
      route.model,
      route.interfaceProvider,
      route.baseUrl,
    ]),
  );
});
it("clears overrides durably without promoting detected values into user intent", async () => {
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      schemaVersion: 2,
      activeProfileId: "one",
      models: [
        {
          ...route,
          contextWindowTokens: 200000,
          maxOutputTokens: 64000,
          detectedContextWindowTokens: 100000,
          detectedRouteKey: JSON.stringify([
            route.provider,
            route.model,
            route.interfaceProvider,
            route.baseUrl,
          ]),
        },
      ],
    }),
  );
  const saved = await updateModelEntry(
    "one",
    { contextWindowTokens: null, maxOutputTokens: null },
    options,
  );
  expect(saved.models[0]).toMatchObject({
    effectiveContextWindowTokens: 100000,
    effectiveMaxOutputTokens: 32768,
  });
  const reloaded = (await readModelSettings(options)).models[0];
  expect(reloaded.contextWindowTokens).toBeUndefined();
  expect(reloaded.maxOutputTokens).toBeUndefined();
});
it("keeps an incompatible small window readable and marks only that model", async () => {
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      schemaVersion: 2,
      activeProfileId: "one",
      models: [{ ...route, contextWindowTokens: 16384 }],
    }),
  );
  expect((await readModelSettings(options)).models[0]).toMatchObject({
    effectiveContextWindowTokens: 16384,
    tokenBudgetIssue: {
      code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE",
      contextWindowTokens: 16384,
      maxOutputTokens: 32768,
    },
  });
});
it("does not reinterpret or overwrite future document versions", async () => {
  const raw = JSON.stringify({
    schemaVersion: 3,
    activeProfileId: "one",
    models: [{ ...route, contextWindowTokens: 128000, maxOutputTokens: 8192 }],
  });
  await writeFile(options.modelJsonPath, raw);
  await expect(readModelDocument(options)).rejects.toThrow(/version/i);
  expect(await readFile(options.modelJsonPath, "utf8")).toBe(raw);
});
it("expands legacy top-level data before migrating 8192 and context", async () => {
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      provider: "custom",
      defaultModel: "unknown",
      apiConfig: {
        baseUrl: route.baseUrl,
        interfaceProvider: route.interfaceProvider,
      },
      llmParams: { maxTokens: 8192, contextWindowTokens: 128000 },
    }),
  );
  const entry = (await readModelSettings(options)).models[0];
  expect(entry).toMatchObject({
    detectedContextWindowTokens: 128000,
    effectiveMaxOutputTokens: 32768,
  });
  expect(entry.contextWindowTokens).toBeUndefined();
  expect(entry.maxOutputTokens).toBeUndefined();
});
it("automatically discovers effort after Save and publishes terminal state without replacing an override", async () => {
  let posts = 0;
  let notifications = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        if (typeof init.body !== "string")
          throw new Error("Expected JSON request body");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response("{}", {
            status: body.reasoning_effort === "high" ? 200 : 400,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          data: [{ id: "unknown", context_length: 100000 }],
        }),
      );
    }),
  );
  const saved = await createModelEntry(
    {
      provider: "custom",
      model: "unknown",
      baseUrl: route.baseUrl,
      interfaceProvider: "openai-compatible",
      contextWindowTokens: 200000,
    },
    {
      ...options,
      onDiscovery: () => {
        notifications++;
      },
    },
  );
  await vi.waitFor(async () => {
    expect((await readModelSettings(options)).models[0].reasoning.status).toBe(
      "identified",
    );
  });
  const view = (await readModelSettings(options)).models[0];
  expect(saved.models[0].contextDiscovery.status).toBe("detecting");
  expect(saved.models[0].reasoning.status).toBe("detecting");
  expect(posts).toBeGreaterThan(0);
  expect(notifications).toBeGreaterThan(1);
  expect(view).toMatchObject({
    contextWindowTokens: 200000,
    detectedContextWindowTokens: 100000,
    effectiveContextWindowTokens: 200000,
    reasoning: { efforts: ["high"] },
  });
  expect(view.id).toBe(saved.models[0].id);
});
it("does not use a placeholder to probe a missing credential reference", async () => {
  await createModelEntry(
    {
      provider: "custom",
      model: "unknown",
      baseUrl: route.baseUrl,
      interfaceProvider: "openai-compatible",
      apiKeyEnv: "MISSING_AUTOMATION_KEY",
    },
    options,
  );
  await vi.waitFor(async () => {
    expect((await readModelSettings(options)).models[0].reasoning.status).toBe(
      "unknown",
    );
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not probe on read or an unchanged patch but retries an actual edit", async () => {
  await writeFile(
    options.modelJsonPath,
    JSON.stringify({
      schemaVersion: 2,
      activeProfileId: "one",
      models: [route],
    }),
  );
  await readModelSettings(options);
  await updateModelEntry("one", {}, options);
  await updateModelEntry("one", { model: undefined }, options);
  expect(fetch).not.toHaveBeenCalled();
  const saved = await updateModelEntry(
    "one",
    { label: "Retry discovery" },
    options,
  );
  expect(saved.models[0].reasoning.status).toBe("detecting");
  await vi.waitFor(async () => {
    expect((await readModelSettings(options)).models[0].reasoning.status).toBe(
      "unknown",
    );
  });
  expect(fetch).toHaveBeenCalled();
});
it.each(["context", "reasoning"] as const)(
  "does not relabel stale evidence when only %s discovery succeeds after manual route edits",
  async (phase) => {
    const oldRouteKey = JSON.stringify([
      route.provider,
      route.model,
      route.interfaceProvider,
      route.baseUrl,
    ]);
    const changed = {
      ...route,
      model: "new-route",
      detectedContextWindowTokens: 200000,
      detectedRouteKey: oldRouteKey,
      reasoningCapabilities: {
        mode: "effort",
        wire: "openai",
        efforts: ["high"],
        supportsDisabled: false,
      },
      reasoningCapabilitySource: "active-probe",
    };
    await writeFile(
      options.modelJsonPath,
      JSON.stringify({
        schemaVersion: 2,
        activeProfileId: "one",
        models: [changed],
      }),
    );
    const before = (await readModelSettings(options)).models[0];
    expect(before.effectiveContextWindowTokens).toBe(300000);
    expect(before.reasoning.status).toBe("unknown");
    const currentRouteKey = JSON.stringify([
      route.provider,
      changed.model,
      route.interfaceProvider,
      route.baseUrl,
    ]);
    await writeModelEntryMetadata(
      "one",
      {
        generation: modelEntryGeneration("one", options),
        routeKey: currentRouteKey,
      },
      phase === "context"
        ? { contextWindowTokens: 16384 }
        : {
            reasoningCapabilities: {
              mode: "effort",
              wire: "openai",
              efforts: ["low"],
              supportsDisabled: false,
            },
            reasoningCapabilitySource: "active-probe",
          },
      options,
    );
    const after = (await readModelSettings(options)).models[0];
    if (phase === "context") {
      expect(after).toMatchObject({
        detectedContextWindowTokens: 16384,
        contextDiscovery: { status: "identified" },
        tokenBudgetIssue: { code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE" },
      });
      expect(after.reasoning.status).toBe("unknown");
    } else {
      expect(after.effectiveContextWindowTokens).toBe(300000);
      expect(after.detectedContextWindowTokens).toBeUndefined();
      expect(after.reasoning.efforts).toEqual(["low"]);
    }
    expect(fetch).not.toHaveBeenCalled();
  },
);
