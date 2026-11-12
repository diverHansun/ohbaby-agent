import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { modelProfileRouteKey } from "ohbaby-llm";
import { startModelEntryDiscovery } from "../apply-active-model-config.js";
import { readModelSettings, updateModelEntry } from "../writer.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("starts discovery for a hand-edited route on a label Save while the old route is still in flight", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-entry-route-race-"));
  vi.stubEnv("OHBABY_HOME", root);
  const modelJsonPath = join(root, "model.json");
  const options = { modelJsonPath, envPath: join(root, ".env") };
  const route = {
    id: "route-race",
    provider: "custom",
    model: "same",
    baseUrl: "https://route-a.invalid/v1",
    interfaceProvider: "openai-compatible" as const,
  };
  const aRequested = deferred<undefined>();
  const bRequested = deferred<undefined>();
  const aResponse = deferred<Response>();
  const bResponse = deferred<Response>();
  const bFinished = deferred<undefined>();
  const urls: string[] = [];
  let oldDiscovery: ReturnType<typeof startModelEntryDiscovery> | undefined;
  const metadata = (capacity: number): Response =>
    Response.json({
      data: [{ id: route.model, context_length: capacity, reasoning: false }],
    });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://route-a.invalid/")) {
        aRequested.resolve(undefined);
        // Deliberately allow a late response despite cancellation.
        return aResponse.promise;
      }
      if (url.startsWith("https://route-b.invalid/")) {
        bRequested.resolve(undefined);
        return bResponse.promise;
      }
      return Promise.reject(new Error("Unexpected fixture route"));
    }),
  );
  try {
    await writeFile(
      modelJsonPath,
      JSON.stringify({
        schemaVersion: 2,
        activeProfileId: route.id,
        models: [route],
      }),
    );
    oldDiscovery = startModelEntryDiscovery(route.id, {
      ...options,
    });
    await aRequested.promise;
    const editedRoute = { ...route, baseUrl: "https://route-b.invalid/v1" };
    await writeFile(
      modelJsonPath,
      JSON.stringify({
        schemaVersion: 2,
        activeProfileId: route.id,
        models: [editedRoute],
      }),
    );
    const saved = await updateModelEntry(
      route.id,
      { label: "edited after route changed on disk" },
      {
        ...options,
        onDiscovery: async (): Promise<void> => {
          const current = (await readModelSettings(options)).models[0];
          if (
            current.contextDiscovery.status !== "detecting" &&
            current.reasoning.status !== "detecting"
          )
            bFinished.resolve(undefined);
        },
      },
    );
    expect(saved.models[0]).toMatchObject({
      baseUrl: editedRoute.baseUrl,
      contextDiscovery: { status: "detecting" },
      reasoning: { status: "detecting" },
    });
    await bRequested.promise;
    bResponse.resolve(metadata(222222));
    await bFinished.promise;
    aResponse.resolve(metadata(999999));
    await oldDiscovery;
    const current = (await readModelSettings(options)).models[0];
    expect(current).toMatchObject({
      baseUrl: editedRoute.baseUrl,
      detectedContextWindowTokens: 222222,
      effectiveContextWindowTokens: 222222,
      contextDiscovery: { status: "identified" },
      reasoning: { status: "identified", mode: "none" },
    });
    const persisted = JSON.parse(await readFile(modelJsonPath, "utf8")) as {
      models: Record<string, unknown>[];
    };
    expect(persisted.models[0]).toMatchObject({
      detectedContextWindowTokens: 222222,
      detectedRouteKey: modelProfileRouteKey(editedRoute, editedRoute.provider),
    });
    expect(urls).toEqual([
      "https://route-a.invalid/v1/models",
      "https://route-b.invalid/v1/models",
    ]);
  } finally {
    aResponse.resolve(metadata(999999));
    bResponse.resolve(metadata(222222));
    await oldDiscovery;
    if (urls.some((url) => url.startsWith("https://route-b.invalid/")))
      await bFinished.promise;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
