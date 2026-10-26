import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createModelEntry,
  updateModelEntry,
  selectModelEntry,
  deleteModelEntry,
  readModelSettings,
} from "../writer.js";
import { readModelDocument } from "../model-document.js";
import * as modelDocument from "../model-document.js";
let dir: string;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let requests: {
  method: string;
  url: string;
  key: string;
  response: ServerResponse;
}[];
let notifications: number;
let opts: { modelJsonPath: string; envPath: string; onDiscovery: () => void };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "entry-discovery-"));
  vi.stubEnv("OHBABY_HOME", dir);
  requests = [];
  notifications = 0;
  server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "",
      key: request.headers.authorization ?? "",
      response,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1`;
  opts = {
    modelJsonPath: join(dir, "model.json"),
    envPath: join(dir, ".env"),
    onDiscovery: (): void => {
      notifications++;
    },
  };
});
afterEach(async () => {
  for (const request of requests) request.response.end();
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const capability = {
  mode: "effort",
  wire: "openai",
  supportsDisabled: true,
  efforts: ["low", "high"],
};
function answer(
  index: number,
  window: number,
  efforts = ["low", "high"],
): void {
  requests[index].response.setHeader("content-type", "application/json");
  requests[index].response.end(
    JSON.stringify({
      data: [
        {
          id: "same",
          context_length: window,
          reasoning_capabilities: { ...capability, efforts },
        },
      ],
    }),
  );
}
async function add(key: string): Promise<import("ohbaby-sdk").UiSettingsModel> {
  const result = await createModelEntry(
    {
      provider: "custom",
      model: "same",
      baseUrl,
      interfaceProvider: "openai-compatible",
      apiKey: key,
    },
    opts,
  );
  const entry = result.models.at(-1);
  if (!entry) throw new Error("Missing saved entry");
  return entry;
}
it("returns saved before metadata, discovers candidates independently without POST or changing selection/params", async () => {
  const a = await add("a");
  const b = await add("b");
  expect((await readModelSettings(opts)).active?.id).toBe(a.id);
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  answer(
    requests.findIndex((request) => request.key === "Bearer b"),
    22222,
    ["high"],
  );
  answer(
    requests.findIndex((request) => request.key === "Bearer a"),
    11111,
    ["low"],
  );
  await vi.waitFor(() => {
    expect(notifications).toBe(2);
  });
  const document = await readModelDocument(opts);
  expect(document.models.map((e) => e.id)).toEqual([a.id, b.id]);
  expect(document.models.map((e) => e.contextWindowTokens)).toEqual([
    11111, 22222,
  ]);
  expect(document.models.map((e) => e.reasoningCapabilities?.efforts)).toEqual([
    ["low"],
    ["high"],
  ]);
  expect(document.activeProfileId).toBe(a.id);
  expect(
    document.models.every((entry) => entry.maxOutputTokens === undefined),
  ).toBe(true);
  expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
});
it("same-reference key replacement invalidates late old key metadata and clears old auto capability", async () => {
  const a = await add("old");
  await vi.waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  const document = await readModelDocument(opts);
  Object.assign(document.models[0], {
    reasoningCapabilities: capability,
    reasoningCapabilitySource: "model-metadata",
  });
  await writeFile(opts.modelJsonPath, JSON.stringify(document));
  await updateModelEntry(a.id, { apiKey: "new" }, opts);
  expect((await readModelDocument(opts)).models[0].apiKeyEnv).toBe(a.apiKeyEnv);
  expect(
    (await readModelDocument(opts)).models[0].reasoningCapabilities,
  ).toBeUndefined();
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  expect(requests.map((r) => r.key)).toEqual(["Bearer old", "Bearer new"]);
  answer(1, 22222);
  await vi.waitFor(() => {
    expect(notifications).toBe(1);
  });
  answer(0, 999999);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect((await readModelDocument(opts)).models[0].contextWindowTokens).toBe(
    22222,
  );
});
it("late results cannot resurrect deletion or override a later active selection", async () => {
  const a = await add("a");
  const b = await add("b");
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  await selectModelEntry(b.id, opts);
  await deleteModelEntry(a.id, opts);
  answer(
    requests.findIndex((request) => request.key === "Bearer a"),
    999999,
  );
  answer(
    requests.findIndex((request) => request.key === "Bearer b"),
    22222,
  );
  await vi.waitFor(() => {
    expect(notifications).toBeGreaterThanOrEqual(1);
  });
  const document = await readModelDocument(opts);
  expect(document.models.map((e) => e.id)).toEqual([b.id]);
  expect(document.activeProfileId).toBe(b.id);
  expect(
    document.models.find((entry) => entry.id === document.activeProfileId)
      ?.contextWindowTokens,
  ).toBe(22222);
});
it("metadata failures preserve saved candidates, unknown has no guessed efforts or active probes", async () => {
  await add("a");
  await vi.waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  requests[0].response.writeHead(401).end("secret-error");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const settings = await readModelSettings(opts);
  expect(settings.models).toHaveLength(1);
  expect(settings.models[0].reasoning).toEqual({
    status: "unknown",
    efforts: [],
  });
  expect(requests).toHaveLength(1);
  expect(await readFile(opts.modelJsonPath, "utf8")).not.toContain(
    "secret-error",
  );
});
it("superseded scheduled jobs stop before invoking fetch with an already aborted signal", async () => {
  const { startModelEntryDiscovery } =
    await import("../apply-active-model-config.js");
  const a = await add("a");
  await vi.waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  answer(0, 12345);
  await vi.waitFor(() => {
    expect(notifications).toBe(1);
  });
  const { coordinateModelConfig } = await import("../config-coordination.js");
  // Keep scheduled network work paused until both snapshots exist, proving pre-start cancellation.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const first = startModelEntryDiscovery(a.id, opts);
    const second = startModelEntryDiscovery(a.id, opts);
    await coordinateModelConfig(opts.modelJsonPath, () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect((await first).reasoningReason).toBe("cancelled");
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    answer(1, 45678);
    await second;
    expect((await readModelDocument(opts)).models[0].contextWindowTokens).toBe(
      45678,
    );
  } finally {
    vi.useRealTimers();
  }
});

it("concurrent legacy saves discover their atomically saved entries without retargeting the earlier job to the later active model", async () => {
  const { applyActiveModelConfig } =
    await import("../apply-active-model-config.js");
  const { coordinateModelConfig } = await import("../config-coordination.js");
  let entered!: () => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = coordinateModelConfig(opts.modelJsonPath, async () => {
    entered();
    await gate;
  });
  await acquired;
  const endpoint = new URL(baseUrl).origin;
  const common = {
    ...opts,
    provider: "legacy",
    model: "same",
    interfaceProvider: "openai-compatible" as const,
    projectRoot: dir,
    deferMetadata: true,
  };
  const saves = Promise.all(
    ["a", "b"].map((name) =>
      applyActiveModelConfig({
        ...common,
        baseUrl: `${endpoint}/${name}/v1`,
        apiKey: `legacy-${name}`,
      }),
    ),
  );
  // Both saves are queued before releasing publication; A's continuation runs after B has ownership.
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await blocker;
  const saved = await saves;
  expect(saved.map((entry) => entry.baseUrl)).toEqual([
    `${endpoint}/a/v1`,
    `${endpoint}/b/v1`,
  ]);
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  expect(requests.map((request) => [request.url, request.key]).sort()).toEqual([
    ["/a/v1/models", "Bearer legacy-a"],
    ["/b/v1/models", "Bearer legacy-b"],
  ]);
  const before = await readModelDocument(opts);
  expect(before.models).toHaveLength(2);
  const a = before.models[0];
  const b = before.models[1];
  expect(before.activeProfileId).toBe(b.id);
  // Let the later active entry finish first, then the earlier entry's late writeback.
  answer(
    requests.findIndex((request) => request.url === "/b/v1/models"),
    22222,
  );
  await vi.waitFor(() => {
    expect(notifications).toBe(1);
  });
  answer(
    requests.findIndex((request) => request.url === "/a/v1/models"),
    11111,
  );
  await vi.waitFor(() => {
    expect(notifications).toBe(2);
  });
  const document = await readModelDocument(opts);
  expect(
    document.models.map((entry) => [entry.id, entry.contextWindowTokens]),
  ).toEqual([
    [a.id, 11111],
    [b.id, 22222],
  ]);
  expect(document.activeProfileId).toBe(b.id);
  expect(
    document.models.find((entry) => entry.id === document.activeProfileId)
      ?.baseUrl,
  ).toBe(`${endpoint}/b/v1`);
  expect(
    document.models.find((entry) => entry.id === document.activeProfileId)
      ?.contextWindowTokens,
  ).toBe(22222);
});

it("contains discovery preparation failure after a successful save without losing the saved entry", async () => {
  const entry = await add("a");
  await vi.waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  answer(0, 12345);
  await vi.waitFor(() => {
    expect(notifications).toBe(1);
  });
  const { startModelEntryDiscovery } =
    await import("../apply-active-model-config.js");
  const read = vi
    .spyOn(modelDocument, "readModelDocument")
    .mockRejectedValueOnce(new Error("fixture read I/O failure"));
  try {
    await expect(
      startModelEntryDiscovery(entry.id, { ...opts, allowActiveProbe: true }),
    ).resolves.toEqual({ reasoningReason: "network-error" });
    expect((await readModelDocument(opts)).models[0].id).toBe(entry.id);
    expect(requests).toHaveLength(1);
  } finally {
    read.mockRestore();
  }
});
it("keeps a budget or label edit and does not restart discovery when the connection is unchanged", async () => {
  const a = await add("a");
  await vi.waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  answer(0, 200000);
  await vi.waitFor(() => {
    expect(notifications).toBe(1);
  });
  await updateModelEntry(
    a.id,
    { contextWindowTokens: 64000, label: "Edited" },
    opts,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A restarted task would also replace (and so cancel) a selection's active probe.
  expect(requests).toHaveLength(1);
  const [entry] = (await readModelDocument(opts)).models;
  expect(entry.contextWindowTokens).toBe(64000);
  expect(entry.label).toBe("Edited");
});

it("preserves budget edited while metadata is still pending", async () => {
  const a = await add("a");
  await vi.waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  await updateModelEntry(
    a.id,
    { contextWindowTokens: 64000, label: "Manual" },
    opts,
  );
  answer(0, 200000);
  await vi.waitFor(() => {
    expect(notifications).toBe(1);
  });
  const [entry] = (await readModelDocument(opts)).models;
  expect(entry.contextWindowTokens).toBe(64000);
  expect(entry.reasoningCapabilities?.efforts).toEqual(["low", "high"]);
});
