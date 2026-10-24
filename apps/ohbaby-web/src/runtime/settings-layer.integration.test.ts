import type { UiSettingsModels } from "ohbaby-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectSettings } from "../store/settings-cache.js";
import { DEFAULT, fakeDaemon } from "./fake-daemon.test-support.js";
import { createOhbabyWebRuntime, type OhbabyWebRuntime } from "./index.js";

const runtimes: OhbabyWebRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

function models(
  ids: readonly string[],
  active: string | null,
): UiSettingsModels {
  return {
    active: active ? { id: active, provider: "p", model: active } : null,
    params: { maxTokens: 1024 },
    models: ids.map((id) => ({
      id,
      provider: "p",
      model: id,
      apiKeyConfigured: false,
      configurationComplete: true,
      contextWindowTokens: 1000,
      reasoning: { status: "unknown", efforts: [] },
    })),
  };
}

async function started(
  daemon: ReturnType<typeof fakeDaemon>,
): Promise<OhbabyWebRuntime> {
  const runtime = createOhbabyWebRuntime(
    { baseUrl: "http://127.0.0.1:4096", clientId: "web", token: "token" },
    { fetch: daemon.fetch },
  );
  runtimes.push(runtime);
  await runtime.ready;
  await vi.waitFor(() => {
    expect(runtime.store.getSnapshot().connectionState).toBe("live");
  });
  return runtime;
}

describe("settings data through the real client", () => {
  it("forwards model.invalidated and settings.changed from the event stream", async () => {
    const daemon = fakeDaemon();
    let reads = 0;
    daemon.settings = (method, path): Response | undefined => {
      if (method === "GET" && path === "/v1/settings/models") {
        reads += 1;
        return Response.json({ ok: true, ...models(["a"], "a") });
      }
      return undefined;
    };
    const runtime = await started(daemon);
    const client = runtime.client;
    if (!client) throw new Error("expected a connected client");
    const seen: string[] = [];
    client.subscribeEvents((event) => {
      seen.push(event.type);
    });
    const stopWatching = runtime.settings.watch("models");
    await runtime.settings.load("models");
    expect(reads).toBe(1);
    const modelReads = (): number =>
      daemon.requests.filter((request) => request.path === "/v1/model").length;
    const before = modelReads();

    daemon.emit(DEFAULT, { type: "model.invalidated" });
    await vi.waitFor(() => {
      expect(seen).toContain("model.invalidated");
    });
    // The instance model and the settings cache both reread.
    await vi.waitFor(() => {
      expect(modelReads()).toBe(before + 1);
      expect(reads).toBe(2);
    });

    daemon.emit(DEFAULT, { type: "settings.changed", domains: ["model"] }, 7);
    await vi.waitFor(() => {
      expect(seen).toContain("settings.changed");
      expect(reads).toBe(3);
    });
    stopWatching();
  });

  it("keeps a confirmed write when an older read answers after it", async () => {
    const daemon = fakeDaemon();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    daemon.settings = async (method, path): Promise<Response | undefined> => {
      if (method === "GET" && path === "/v1/settings/models") {
        await held;
        return Response.json({ ok: true, ...models(["a"], null) });
      }
      if (method === "POST" && path === "/v1/settings/models/profiles")
        return Response.json({ ok: true, ...models(["a", "b"], null) });
      return undefined;
    };
    const runtime = await started(daemon);
    const read = runtime.settings.load("models");
    const written = await runtime.settings.createModel({
      provider: "p",
      model: "b",
      baseUrl: "https://p.test/v1",
      interfaceProvider: "openai-compatible",
    });
    expect(written.models.map((model) => model.id)).toEqual(["a", "b"]);
    release();
    await read;
    expect(
      selectSettings(
        runtime.settings.cache.getSnapshot(),
        "models",
      ).data?.models.map((model) => model.id),
    ).toEqual(["a", "b"]);
  });

  it("keeps field errors from a validation failure", async () => {
    const daemon = fakeDaemon();
    daemon.settings = (method, path): Response | undefined =>
      method === "PUT" && path === "/v1/settings/search"
        ? Response.json(
            {
              ok: false,
              error: {
                code: "VALIDATION_FAILED",
                message: "Invalid settings",
                fields: [
                  {
                    path: ["defaults", "timeout"],
                    message: "Must be at most 600",
                  },
                  { path: "not-a-path", message: 3 },
                ],
              },
            },
            { status: 400 },
          )
        : undefined;
    const runtime = await started(daemon);
    await expect(
      runtime.settings.updateSearch({ defaults: { timeout: 900 } }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
      fields: [
        { path: ["defaults", "timeout"], message: "Must be at most 600" },
      ],
    });
    // Global settings calls carry no directory header.
    expect(
      daemon.requests
        .filter((request) => request.path.startsWith("/v1/settings/"))
        .every((request) => request.directory === undefined),
    ).toBe(true);
  });
});
