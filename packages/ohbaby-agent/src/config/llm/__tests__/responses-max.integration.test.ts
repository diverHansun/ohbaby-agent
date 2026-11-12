import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  capabilitiesFor,
  createInterfaceProvider,
  resolveRequestReasoning,
} from "ohbaby-llm";
import { loadModelEntryConfig } from "../manager.js";
import { modelEntryDiscoveryState } from "../apply-active-model-config.js";
import { readModelDocument } from "../model-document.js";
import { createModelEntry, updateModelEntry } from "../writer.js";

let root: string;
let options: { modelJsonPath: string; envPath: string };
let posts: Record<string, unknown>[];
let accepted: string[];
let model: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "responses-max-"));
  options = {
    modelJsonPath: join(root, "model.json"),
    envPath: join(root, ".env"),
  };
  vi.stubEnv("OHBABY_HOME", root);
  posts = [];
  accepted = ["medium", "max"];
  model = "fixture-model";
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST")
      return Promise.resolve(
        Response.json({ data: [{ id: model, context_length: 100000 }] }),
      );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    posts.push(body);
    if (body.stream === true) {
      const event = {
        type: "response.completed",
        response: {
          id: "fixture-response",
          status: "completed",
          output: [],
          store: false,
          previous_response_id: null,
        },
      };
      return Promise.resolve(
        new Response(`data: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    const effort = (body.reasoning as { effort: string }).effort;
    return Promise.resolve(
      new Response(null, { status: accepted.includes(effort) ? 200 : 422 }),
    );
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function discover(baseUrl: string): Promise<string> {
  const created = await createModelEntry(
    {
      provider: "gateway",
      model,
      baseUrl,
      interfaceProvider: "openai-responses",
      apiKey: "fixture-only",
    },
    options,
  );
  const id = created.models[0].id;
  await vi.waitFor(() => {
    expect(modelEntryDiscoveryState(id, options)).toMatchObject({
      context: { status: "identified" },
      reasoning: { status: "identified" },
    });
  });
  return id;
}

it.each(["active-probe", "builtin", "migrated-auto"] as const)(
  "sends capability-confirmed max with ordinary output 32768 through the real Responses SDK (%s)",
  async (source) => {
    let id: string;
    if (source === "migrated-auto") {
      const original = JSON.stringify({
        provider: "gateway",
        defaultModel: model,
        apiConfig: {
          baseUrl: "https://fixture.invalid/v1",
          interfaceProvider: "openai-responses",
        },
        llmParams: { maxTokens: 8192, reasoning: { effort: "max" } },
        models: [
          {
            id: "legacy-max",
            provider: "gateway",
            model,
            baseUrl: "https://fixture.invalid/v1",
            interfaceProvider: "openai-responses",
            contextWindowTokens: 100000,
            reasoningCapabilitySource: "active-probe",
            reasoningCapabilities: {
              mode: "effort",
              wire: "openai",
              supportsDisabled: false,
              efforts: ["medium", "max"],
            },
          },
        ],
      });
      await writeFile(options.modelJsonPath, original);
      const migrated = await readModelDocument(options);
      expect(await readFile(options.modelJsonPath, "utf8")).toBe(original);
      expect(migrated.models[0]).toMatchObject({
        reasoning: { effort: "max" },
        detectedContextWindowTokens: 100000,
      });
      expect(migrated.models[0].maxOutputTokens).toBeUndefined();
      id = migrated.models[0].id;
      await updateModelEntry(id, { label: "Migrated" }, options);
      expect(posts).toHaveLength(0);
    } else {
      if (source === "builtin") model = "openai/gpt-5.6-luna";
      id = await discover(
        source === "builtin"
          ? "https://zenmux.ai/api/v1"
          : "https://fixture.invalid/v1",
      );
      expect(posts).toHaveLength(source === "builtin" ? 0 : 8);
      const beforeSelection = await loadModelEntryConfig(options, id);
      expect(beforeSelection.reasoning).toBeUndefined();
      expect(resolveRequestReasoning(beforeSelection).effort).toBe("medium");
      await updateModelEntry(id, { reasoning: { effort: "max" } }, options);
    }
    const persisted = JSON.parse(
      await readFile(options.modelJsonPath, "utf8"),
    ) as { schemaVersion: number; models: Record<string, unknown>[] };
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.models[0].reasoning).toEqual({ effort: "max" });
    expect(persisted.models[0]).not.toHaveProperty("maxOutputTokens");
    const config = await loadModelEntryConfig(options, id);
    expect(config.maxTokens).toBe(32768);
    expect(capabilitiesFor(config).source).toBe(
      source === "builtin" ? "builtin:zenmux/gpt-5.6-luna" : "active-probe",
    );
    const provider = createInterfaceProvider({
      id: "fixture-provider",
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      interfaceProvider: config.interfaceProvider,
    });
    const stream = await provider.streamResponse({
      model: config.model,
      messages: [{ role: "user", content: "Reply OK." }],
      maxTokens: config.maxTokens,
      promptCache: { strategy: "observe-only", reason: "fixture" },
      reasoning: resolveRequestReasoning(config),
      tools: [
        { name: "noop", inputSchema: { type: "object", properties: {} } },
      ],
    });
    for await (const _event of stream) {
      /* Consume the real SDK SSE parser. */
    }
    expect(posts.filter((body) => body.stream === true)).toHaveLength(1);
    expect(posts.at(-1)).toMatchObject({
      reasoning: { effort: "max" },
      max_output_tokens: 32768,
      stream: true,
      store: false,
    });
    expect(posts.at(-1)?.tools).toEqual([
      {
        type: "function",
        name: "noop",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
  },
);

it("rejects max without supporting capability and rejects arbitrary strengths without changing the saved preference", async () => {
  accepted = ["medium"];
  const id = await discover("https://fixture.invalid/v1");
  for (const effort of ["max", "unrecognized-strength"]) {
    await expect(
      updateModelEntry(id, { reasoning: { effort } }, options),
    ).rejects.toThrow(/effort/iu);
  }
  const config = await loadModelEntryConfig(options, id);
  expect(config.reasoning).toBeUndefined();
  expect(resolveRequestReasoning(config).effort).toBe("medium");
});
