import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as writer from "../writer.js";
import * as atomic from "../../../secrets/atomic-file.js";
import { setActiveLLMConfig } from "../../../llm/writer.js";
import { SearchConfigManager } from "../manager.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "search-settings-"));
  vi.stubEnv("OHBABY_HOME", home);
  vi.stubEnv("STAGE3_SHARED", undefined);
  vi.stubEnv("OHBABY_SEARCH_API_KEY", undefined);
  vi.stubEnv("TAVILY_API_KEY", undefined);
  await mkdir(join(home, "tools"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  SearchConfigManager.resetInstance();
  await rm(home, { force: true, recursive: true });
});
const saved = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(home, "tools/search.json"), "utf8")) as Record<
    string,
    unknown
  >;
it("patches individual defaults and clears base URL without changing an omitted credential", async () => {
  await writer.setSearchApiKey({ apiKey: "initial" });
  await writer.updateSearchSettings({
    baseUrl: "http://127.0.0.1:1",
    defaults: { maxResults: 9, topic: "news" },
  });
  await writer.updateSearchSettings({
    baseUrl: null,
    defaults: { timeout: 11 },
  });
  expect(await saved()).toMatchObject({
    apiKeyEnv: "TAVILY_API_KEY",
    defaults: { maxResults: 9, topic: "news", timeout: 11 },
  });
  expect((await saved()).baseUrl).toBeUndefined();
  expect(await writer.readSearchSettings()).toMatchObject({
    apiKeyConfigured: true,
  });
  expect(JSON.stringify(await writer.readSearchSettings())).not.toContain(
    "initial",
  );
  await writer.updateSearchSettings({ apiKey: "" });
  expect(await readFile(join(home, ".env"), "utf8")).not.toContain(
    "TAVILY_API_KEY=",
  );
  expect(process.env.TAVILY_API_KEY).toBeUndefined();
});
it.each(["top", "entry"])(
  "protects a %s model reference when replacing or clearing search",
  async (kind) => {
    await writeFile(
      join(home, "model.json"),
      JSON.stringify(
        kind === "top"
          ? { apiConfig: { apiKeyEnv: "STAGE3_SHARED" } }
          : { models: [{ apiKeyEnv: "STAGE3_SHARED" }] },
      ),
    );
    await writeFile(join(home, ".env"), "STAGE3_SHARED=model-secret\n# keep\n");
    await writer.updateSearchSettings({ apiKeyEnv: "STAGE3_SHARED" });
    await writer.updateSearchSettings({ apiKey: "search-secret" });
    expect((await saved()).apiKeyEnv).toBe("OHBABY_SEARCH_API_KEY");
    expect(await readFile(join(home, ".env"), "utf8")).toContain(
      "STAGE3_SHARED=model-secret",
    );
    await writer.updateSearchSettings({
      apiKeyEnv: "STAGE3_SHARED",
      apiKey: "",
    });
    expect((await saved()).apiKeyEnv).toBeNull();
    expect(await writer.readSearchSettings()).toMatchObject({
      apiKeyEnv: null,
      apiKeyConfigured: false,
    });
  },
);
it("explicit null stays detached even with a shell default, while clear preserves external shell ownership", async () => {
  vi.stubEnv("TAVILY_API_KEY", "shell-secret");
  await writer.updateSearchSettings({ apiKey: "" });
  expect(process.env.TAVILY_API_KEY).toBe("shell-secret");
  expect(await writer.readSearchSettings()).toMatchObject({
    apiKeyConfigured: true,
  });
  await writer.updateSearchSettings({ apiKeyEnv: null });
  expect(await writer.readSearchSettings()).toMatchObject({
    apiKeyConfigured: false,
    apiKeyEnv: null,
  });
  await expect(
    SearchConfigManager.getInstance().reload(),
  ).rejects.toMatchObject({ code: "MISSING_API_KEY" });
});
it("serializes a failing search commit with a model write on another model path so rollback cannot erase its secret", async () => {
  await writer.setSearchApiKey({ apiKey: "before" });
  const real = atomic.writeFileAtomically;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let failed = false;
  vi.spyOn(atomic, "writeFileAtomically").mockImplementation(
    async (path, content) => {
      if (path === join(home, "tools/search.json") && !failed) {
        failed = true;
        entered();
        await gate;
        throw new Error("controlled write failure");
      }
      return real(path, content);
    },
  );
  const search = writer
    .setSearchApiKey({ apiKey: "bad" })
    .catch((e: unknown) => e);
  await started;
  let completed = false;
  const model = setActiveLLMConfig({
    provider: "test",
    model: "test",
    baseUrl: "http://localhost:1",
    modelJsonPath: join(home, "other-model.json"),
    apiKeyEnv: "STAGE3_SHARED",
    apiKey: "model-secret",
  }).then(() => {
    completed = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(completed).toBe(false);
  release();
  expect(await search).toBeInstanceOf(Error);
  await model;
  expect(await readFile(join(home, ".env"), "utf8")).toContain(
    "STAGE3_SHARED=model-secret",
  );
  expect(await readFile(join(home, ".env"), "utf8")).toContain(
    "TAVILY_API_KEY=before",
  );
});
it("redacts URL credentials in search settings while preserving the executable saved URL", async () => {
  const url =
    "https://user:password-sentinel@example.test/search?token=query-sentinel";
  await writer.updateSearchSettings({ baseUrl: url });
  expect(JSON.stringify(await writer.readSearchSettings())).not.toMatch(
    /password-sentinel|query-sentinel/,
  );
  expect((await saved()).baseUrl).toBe(url);
});
it("keeps direct credential readers outside an in-flight search publication and its rollback", async () => {
  const { loadEnvFile } = await import("../../../llm/loaders.js");
  await writer.setSearchApiKey({ apiKey: "before" });
  const real = atomic.writeFileAtomically;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let failed = false;
  vi.spyOn(atomic, "writeFileAtomically").mockImplementation(
    async (path, content) => {
      if (path === join(home, "tools/search.json") && !failed) {
        failed = true;
        entered();
        await gate;
        throw new Error("controlled search publication failure");
      }
      return real(path, content);
    },
  );
  const save = writer
    .setSearchApiKey({ apiKey: "uncommitted" })
    .catch((e: unknown) => e);
  await started;
  let returned = false;
  const read = loadEnvFile(join(home, ".env")).then((value) => {
    returned = true;
    return value;
  });
  try {
    await new Promise((r) => setTimeout(r, 20));
    expect(returned).toBe(false);
  } finally {
    release();
    await save;
  }
  expect(await read).toEqual({ TAVILY_API_KEY: "before" });
});
it.each([
  "https://credential-sentinel@example.test/search?topic=news",
  "https://example.test/search?%74oken=credential%2Dsentinel&topic=news",
])(
  "redacts parsed URL credentials from search PUT and GET without changing saved %s",
  async (url) => {
    const updated = await writer.updateSearchSettings({ baseUrl: url });
    const read = await writer.readSearchSettings();
    for (const settings of [updated, read]) {
      expect(JSON.stringify(settings)).not.toMatch(
        /credential(?:-|%2D)sentinel/i,
      );
      expect(new URL(settings.baseUrl ?? "").searchParams.get("topic")).toBe(
        "news",
      );
    }
    expect((await saved()).baseUrl).toBe(url);
  },
);
it("repoints the key variable without deleting the previously saved value", async () => {
  await writer.setSearchApiKey({ apiKey: "saved-search-key" });
  await writer.updateSearchSettings({ apiKeyEnv: "OTHER_SEARCH_KEY" });
  expect(await saved()).toMatchObject({ apiKeyEnv: "OTHER_SEARCH_KEY" });
  expect(await readFile(join(home, ".env"), "utf8")).toContain(
    "TAVILY_API_KEY=saved-search-key",
  );
});
it("clearing never deletes a variable the user manages outside search", async () => {
  vi.stubEnv("GITHUB_TOKEN", undefined);
  vi.stubEnv("MY_SEARCH_TOKEN", undefined);
  await writeFile(
    join(home, ".env"),
    "GITHUB_TOKEN=github-user-token\nMY_SEARCH_TOKEN=user-search-token\n",
  );
  await writer.updateSearchSettings({ apiKeyEnv: "GITHUB_TOKEN", apiKey: "" });
  expect(await readFile(join(home, ".env"), "utf8")).toContain(
    "GITHUB_TOKEN=github-user-token",
  );
  expect((await saved()).apiKeyEnv).toBeNull();
  await writer.updateSearchSettings({ apiKeyEnv: "MY_SEARCH_TOKEN" });
  await writer.updateSearchSettings({ apiKey: "" });
  expect(await readFile(join(home, ".env"), "utf8")).toContain(
    "MY_SEARCH_TOKEN=user-search-token",
  );
  expect((await saved()).apiKeyEnv).toBeNull();
  expect(await writer.readSearchSettings()).toMatchObject({
    apiKeyConfigured: false,
  });
});
