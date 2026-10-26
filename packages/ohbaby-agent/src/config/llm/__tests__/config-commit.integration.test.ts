import { parseProjectedDocument } from "./model-document.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as secrets from "../../secrets/env-secrets.js";
import * as atomic from "../../secrets/atomic-file.js";
import { setActiveLLMConfig } from "../writer.js";
import { modelConfigVersion } from "../config-coordination.js";
import { _LLMConfigManager } from "../index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(): Promise<{
  provider: string;
  model: string;
  baseUrl: string;
  modelJsonPath: string;
  envPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-config-commit-"));
  directories.push(directory);
  const input = {
    provider: "test",
    model: "A",
    baseUrl: "https://example.test/v1",
    modelJsonPath: join(directory, "model.json"),
    envPath: join(directory, ".env"),
  };
  await setActiveLLMConfig(input);
  return input;
}
describe("model configuration commit", () => {
  it("restores original model and secret after the second file fails, without publishing a version", async () => {
    const input = await setup();
    const before = await modelConfigVersion(input.modelJsonPath, input.envPath);
    vi.spyOn(secrets, "writeEnvSecret").mockRejectedValueOnce(
      new Error("secret write failed"),
    );
    await expect(
      setActiveLLMConfig({
        ...input,
        model: "B",
        apiKey: "test-only",
        apiKeyEnv: "TEST_COMMIT_SECRET",
      }),
    ).rejects.toThrow("secret write failed");
    expect(await modelConfigVersion(input.modelJsonPath, input.envPath)).toBe(
      before,
    );
    expect(
      (
        parseProjectedDocument(await readFile(input.modelJsonPath, "utf8")) as {
          defaultModel: string;
        }
      ).defaultModel,
    ).toBe("A");
  });
  it("blocks coordinated reads if rollback fails, and allows a repair save", async () => {
    const input = await setup();
    const realWrite = atomic.writeFileAtomically;
    let writes = 0;
    vi.spyOn(atomic, "writeFileAtomically").mockImplementation(
      async (...args) => {
        if (++writes === 2) throw new Error("rollback failed");
        return realWrite(...args);
      },
    );
    vi.spyOn(secrets, "writeEnvSecret").mockRejectedValueOnce(
      new Error("secret write failed"),
    );
    await expect(
      setActiveLLMConfig({
        ...input,
        model: "B",
        apiKey: "test-only",
        apiKeyEnv: "TEST_COMMIT_SECRET",
      }),
    ).rejects.toThrow("partially saved");
    await expect(
      modelConfigVersion(input.modelJsonPath, input.envPath),
    ).rejects.toThrow("partially saved");
    await expect(_LLMConfigManager.getInstance().reload(input)).rejects.toThrow(
      "partially saved",
    );
    await setActiveLLMConfig({ ...input, model: "C" });
    await expect(
      modelConfigVersion(input.modelJsonPath, input.envPath),
    ).resolves.toEqual(expect.any(String));
  });
  it("serializes concurrent workspace writers without losing route profiles", async () => {
    const input = await setup();
    await Promise.all(
      ["B", "C", "D"].map((model) =>
        setActiveLLMConfig({
          ...input,
          model,
          updateActiveModelProfile: true,
          contextWindowTokens: 1000,
        }),
      ),
    );
    const saved = parseProjectedDocument(
      await readFile(input.modelJsonPath, "utf8"),
    ) as {
      defaultModel: string;
      models: { model: string }[];
    };
    expect(saved.defaultModel).toBe("D");
    expect(
      saved.models.map((profile: { model: string }) => profile.model),
    ).toEqual(["A", "B", "C", "D"]);
  });
  it("uses externally edited disk secrets at new admission while preserving explicit caller env", async () => {
    const input = await setup();
    const envName = "STAGE_B_ROTATED_SECRET";
    const previous = process.env[envName];
    try {
      await setActiveLLMConfig({
        ...input,
        apiKeyEnv: envName,
        apiKey: "fake-old",
      });
      const before = await modelConfigVersion(
        input.modelJsonPath,
        input.envPath,
      );
      await atomic.writeFileAtomically(input.envPath, `${envName}=fake-new\n`);
      expect(
        await modelConfigVersion(input.modelJsonPath, input.envPath),
      ).not.toBe(before);
      const reloaded = await _LLMConfigManager.getInstance().reload(input);
      expect(reloaded.apiKey === "fake-new").toBe(true);
      const explicit = await _LLMConfigManager
        .getInstance()
        .reload({ ...input, env: { [envName]: "fake-explicit" } });
      expect(explicit.apiKey === "fake-explicit").toBe(true);
    } finally {
      if (previous === undefined) delete process.env.STAGE_B_ROTATED_SECRET;
      else process.env[envName] = previous;
    }
  });
});
it("direct model readers wait for publication rollback instead of observing an uncommitted model", async () => {
  const { loadModelJson } = await import("../loaders.js");
  const input = await setup();
  let enter!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.spyOn(secrets, "writeEnvSecret").mockImplementationOnce(async () => {
    enter();
    await gate;
    throw new Error("controlled env failure");
  });
  const save = setActiveLLMConfig({
    ...input,
    model: "uncommitted",
    apiKeyEnv: "STAGE3_READ",
    apiKey: "test-only",
  }).catch((e: unknown) => e);
  await entered;
  let returned = false;
  const read = loadModelJson({ modelJsonPath: input.modelJsonPath }).then(
    (value) => {
      returned = true;
      return value;
    },
  );
  try {
    await new Promise((r) => setTimeout(r, 20));
    expect(returned).toBe(false);
  } finally {
    release();
    await save;
  }
  expect(await read).toMatchObject({ models: [{ model: "A" }] });
});
