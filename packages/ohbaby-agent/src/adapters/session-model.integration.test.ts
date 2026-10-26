import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LLMConfig,
  LLMClientInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

function entry(
  id: string,
  window = 128_000,
): import("../config/llm/model-document.js").ModelEntry {
  return {
    id,
    provider: id,
    model: `model-${id}`,
    baseUrl: `https://${id}.invalid/v1`,
    interfaceProvider: "openai-compatible",
    contextWindowTokens: window,
    maxOutputTokens: 512,
    reasoningCapabilities: {
      mode: "none",
      wire: "none",
      supportsDisabled: true,
    },
  };
}
function fake(
  config: LLMConfig,
  requests: { config: LLMConfig; request: InterfaceProviderRequest }[],
  beforeResponse: (
    config: LLMConfig,
    request: InterfaceProviderRequest,
  ) => Promise<void>,
): LLMClientInstance {
  return {
    config,
    provider: {
      id: config.provider,
      kind: config.interfaceProvider,
      client: {},
      async streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push({ config, request });
        await beforeResponse(config, request);
        return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
          yield await Promise.resolve({
            textDelta: "A useful response",
            finishReason: "stop",
          });
        })();
      },
      isAbortError: () => false,
    },
  };
}

describe("session model integration", () => {
  let beforeResponse: (
    config: LLMConfig,
    request: InterfaceProviderRequest,
  ) => Promise<void>;
  let beforeSubmit: () => Promise<void>;
  let directory: string;
  let home: string;
  let client: ReturnType<typeof createInProcessUiBackendClient>;
  const requests: { config: LLMConfig; request: InterfaceProviderRequest }[] =
    [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "session-model-"));
    home = join(directory, "config");
    await mkdir(home);
    vi.stubEnv("OHBABY_HOME", home);
    requests.length = 0;
    beforeSubmit = (): Promise<void> => Promise.resolve();
    beforeResponse = (): Promise<void> => Promise.resolve();
    await writeFile(
      join(home, "model.json"),
      JSON.stringify({
        activeProfileId: "a",
        models: [entry("a"), entry("b", 32_000)],
      }),
    );
    client = createInProcessUiBackendClient({
      workdir: directory,
      beforePromptSubmit: () => beforeSubmit(),
      createLLMClient: (config): Promise<LLMClientInstance> =>
        Promise.resolve(
          fake(config, requests, (config, request) =>
            beforeResponse(config, request),
          ),
        ),
    });
  });
  afterEach(async () => {
    await client.dispose();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it("persists the initial choice, routes each session independently, and reports its own window", async () => {
    const a = await client.submitPromptAndWait("one", { modelEntryId: "a" });
    const b = await client.submitPromptAndWait("two", { modelEntryId: "b" });
    expect(a.prompt.status).toBe("succeeded");
    expect(b.prompt.status).toBe("succeeded");
    const snapshot = await client.getSnapshot();
    expect(
      snapshot.sessions.find((s) => s.id === b.prompt.sessionId)?.modelEntryId,
    ).toBe("b");
    expect(
      await client.getCurrentModel({ sessionId: b.prompt.sessionId }),
    ).toMatchObject({ id: "b", source: "explicit", model: "model-b" });
    expect(
      await client.getContextWindowUsage({ sessionId: b.prompt.sessionId }),
    ).toMatchObject({ contextWindowTokens: 32_000 });
    expect(
      requests.some((r) => r.config.baseUrl === "https://a.invalid/v1"),
    ).toBe(true);
    expect(
      requests.some((r) => r.config.baseUrl === "https://b.invalid/v1"),
    ).toBe(true);
    expect(
      (
        JSON.parse(await readFile(join(home, "model.json"), "utf8")) as {
          activeProfileId: string;
        }
      ).activeProfileId,
    ).toBe("a");
  });
  it("switches one session without changing the default and can clear its explicit choice", async () => {
    const first = await client.submitPromptAndWait("one");
    const sessionId = first.prompt.sessionId;
    const updated = await client.updateSessionModel({
      sessionId,
      modelEntryId: "b",
    });
    expect(updated.modelEntryId).toBe("b");
    expect(await client.getCurrentModel()).toMatchObject({
      id: "a",
      source: "default",
    });
    expect(await client.getContextWindowUsage({ sessionId })).toMatchObject({
      contextWindowTokens: 32_000,
    });
    await expect(
      client.updateSessionModel({ sessionId, modelEntryId: "missing" }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    expect(
      (await client.updateSessionModel({ sessionId, modelEntryId: null }))
        .modelEntryId,
    ).toBeUndefined();
  });
  it("falls back after deletion, clears the stale choice and publishes the removal notice", async () => {
    const events: unknown[] = [];
    client.subscribeEvents((event) => events.push(event));
    const first = await client.submitPromptAndWait("one", {
      modelEntryId: "b",
    });
    await writeFile(
      join(home, "model.json"),
      JSON.stringify({ activeProfileId: "a", models: [entry("a")] }),
    );
    const next = await client.submitPromptAndWait("two", {
      sessionId: first.prompt.sessionId,
    });
    expect(next.prompt.status).toBe("succeeded");
    expect(
      (await client.getCurrentModel({ sessionId: first.prompt.sessionId }))?.id,
    ).toBe("a");
    expect(
      (await client.getSnapshot()).sessions.find(
        (s) => s.id === first.prompt.sessionId,
      )?.modelEntryId,
    ).toBeUndefined();
    expect(JSON.stringify(events)).toContain(
      `model:entry-removed:${first.prompt.sessionId}`,
    );
  });
  it("does not persist a later per-submission model while the first receipt is still waiting", async () => {
    const entered = deferred();
    const release = deferred();
    beforeSubmit = async (): Promise<void> => {
      entered.resolve();
      await release.promise;
    };
    try {
      const first = await client.submitPromptAccepted("first", {
        sessionId: "empty-queued",
        modelEntryId: "a",
      });
      await entered.promise;
      const second = await client.submitPromptAccepted("second", {
        sessionId: "empty-queued",
        modelEntryId: "b",
      });
      expect(
        (await client.getSnapshot()).sessions.find(
          (s) => s.id === "empty-queued",
        )?.modelEntryId,
      ).toBe("a");
      release.resolve();
      await client.waitForPrompt(first.promptId);
      await client.waitForPrompt(second.promptId);
    } finally {
      release.resolve();
    }
  });
  it.each(["explicit", "default"])(
    "keeps a %s queued snapshot while the active session switches",
    async (mode) => {
      const entered = deferred();
      const release = deferred();
      let held = false;
      const calls: string[] = [];
      beforeResponse = async (config, request): Promise<void> => {
        if (
          JSON.stringify(request).includes("Write a short conversation title")
        )
          return;
        calls.push(config.model);
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      };
      try {
        const first = await client.submitPromptAccepted("first", {
          sessionId: "queued",
          ...(mode === "explicit" ? { modelEntryId: "a" } : {}),
        });
        await entered.promise;
        const second = await client.submitPromptAccepted("second", {
          sessionId: "queued",
        });
        await client.updateSessionModel({
          sessionId: "queued",
          modelEntryId: "b",
        });
        release.resolve();
        await client.waitForPrompt(first.promptId);
        expect(
          (await client.waitForPrompt(second.promptId)).prompt.status,
        ).toBe("succeeded");
        await client.submitPromptAndWait("third", { sessionId: "queued" });
        expect(calls).toEqual(["model-a", "model-a", "model-b"]);
      } finally {
        release.resolve();
      }
    },
  );
  it("runs another model while the first session is still active and preserves the old client after edits", async () => {
    const entered = deferred();
    const release = deferred();
    let held = false;
    beforeResponse = async (config, request): Promise<void> => {
      if (JSON.stringify(request).includes("Write a short conversation title"))
        return;
      if (config.model === "model-a" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    try {
      const first = await client.submitPromptAccepted("first", {
        sessionId: "one",
        modelEntryId: "a",
      });
      await entered.promise;
      await writeFile(
        join(home, "model.json"),
        JSON.stringify({
          activeProfileId: "a",
          models: [
            { ...entry("a"), baseUrl: "https://changed.invalid/v1" },
            entry("b"),
          ],
        }),
      );
      const other = await client.submitPromptAndWait("other", {
        sessionId: "two",
        modelEntryId: "b",
      });
      expect(other.prompt.status).toBe("succeeded");
      release.resolve();
      expect((await client.waitForPrompt(first.promptId)).prompt.status).toBe(
        "succeeded",
      );
      await client.submitPromptAndWait("again", { sessionId: "one" });
      expect(
        requests.some((r) => r.config.baseUrl === "https://changed.invalid/v1"),
      ).toBe(true);
      expect(requests[0].config.baseUrl).toBe("https://a.invalid/v1");
    } finally {
      release.resolve();
    }
  });
  it("starts without a default and executes an explicit valid entry", async () => {
    await writeFile(
      join(home, "model.json"),
      JSON.stringify({ models: [entry("a")] }),
    );
    const explicit = await client.submitPromptAndWait("explicit", {
      sessionId: "explicit",
      modelEntryId: "a",
    });
    expect(explicit.prompt.status).toBe("succeeded");
    const fallback = await client.submitPromptAndWait("default", {
      sessionId: "default",
    });
    expect(fallback.prompt.status).toBe("failed");
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
