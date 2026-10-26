import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type {
  LLMClientInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "keeps the selected model window and accounting while old model work finishes (queued=%s)",
  async (queued) => {
    const directory = await mkdtemp(join(tmpdir(), "model-usage-race-"));
    const home = join(directory, "config");
    await mkdir(home);
    vi.stubEnv("OHBABY_HOME", home);
    const entered = deferred();
    const release = deferred();
    await writeFile(join(directory, "note.txt"), "blue lantern");
    await writeFile(
      join(home, "model.json"),
      JSON.stringify({
        activeProfileId: "a",
        models: [
          {
            id: "a",
            provider: "test",
            model: "large",
            baseUrl: "https://a.invalid/v1",
            interfaceProvider: "openai-compatible",
            contextWindowTokens: 128000,
            maxOutputTokens: 512,
          },
          {
            id: "b",
            provider: "test",
            model: "small",
            baseUrl: "https://b.invalid/v1",
            interfaceProvider: "openai-compatible",
            contextWindowTokens: 32000,
            maxOutputTokens: 512,
          },
        ],
      }),
    );
    const client = createInProcessUiBackendClient({
      workdir: directory,
      createLLMClient: (config): Promise<LLMClientInstance> => {
        let steps = 0;
        return Promise.resolve({
          config,
          provider: {
            id: config.provider,
            kind: config.interfaceProvider,
            client: {},
            isAbortError: (): boolean => false,
            streamResponse(
              request: InterfaceProviderRequest,
            ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
              const title = JSON.stringify(request).includes(
                "Write a short conversation title",
              );
              const step = title ? 0 : ++steps;
              return Promise.resolve(
                (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                  if (title) {
                    yield { textDelta: "Read note", finishReason: "stop" };
                    return;
                  }
                  if (config.model === "large" && step === 1) {
                    entered.resolve();
                    await release.promise;
                    yield {
                      toolCallDeltas: [
                        {
                          id: "read",
                          index: 0,
                          name: "read",
                          argumentsDelta: JSON.stringify({
                            file_path: join(directory, "note.txt"),
                          }),
                        },
                      ],
                      finishReason: "tool_calls",
                      tokenUsage: usage(),
                    };
                  } else {
                    yield {
                      textDelta: "done",
                      finishReason: "stop",
                      tokenUsage: usage(),
                    };
                  }
                })(),
              );
            },
          },
        });
      },
    });
    try {
      const first = await client.submitPromptAccepted("read note", {
        sessionId: "s",
        modelEntryId: "a",
      });
      await entered.promise;
      const second = queued
        ? await client.submitPromptAccepted("queued", { sessionId: "s" })
        : undefined;
      await client.updateSessionModel({ sessionId: "s", modelEntryId: "b" });
      expect(
        await client.getContextWindowUsage({ sessionId: "s" }),
      ).toMatchObject({ contextWindowTokens: 32000 });
      release.resolve();
      expect((await client.waitForPrompt(first.promptId)).prompt.status).toBe(
        "succeeded",
      );
      if (second)
        expect(
          (await client.waitForPrompt(second.promptId)).prompt.status,
        ).toBe("succeeded");
      expect
        .soft(
          (await client.getSnapshot()).contextWindowUsages?.find(
            (usage) => usage.sessionId === "s",
          ),
        )
        .toMatchObject({ contextWindowTokens: 32000 });
      expect
        .soft(await client.getContextWindowUsage({ sessionId: "s" }))
        .toMatchObject({ contextWindowTokens: 32000 });
      expect
        .soft(await cacheUsage(client))
        .toMatchObject({ accountedInputTokens: 0 });
      expect(
        (await client.submitPromptAndWait("next", { sessionId: "s" })).prompt
          .status,
      ).toBe("succeeded");
      expect(await cacheUsage(client)).toMatchObject({
        accountedInputTokens: 90,
        cacheReadTokens: 20,
      });
    } finally {
      release.resolve();
      await client.dispose();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function usage(): NonNullable<InterfaceProviderStreamEvent["tokenUsage"]> {
  return {
    inputTokens: 90,
    outputTokens: 10,
    totalTokens: 100,
    inputBreakdown: {
      uncached: 70,
      cacheRead: 20,
      cacheWrite: 0,
      observed: { cacheRead: true, cacheWrite: true },
    },
  };
}

async function cacheUsage(
  client: ReturnType<typeof createInProcessUiBackendClient>,
): Promise<unknown> {
  let usage: unknown;
  const unsubscribe = client.subscribeEvents((event) => {
    if (
      event.type === "command.result.delivered" &&
      event.output?.kind === "data" &&
      event.output.subject === "status"
    )
      usage = event.output.data.promptCacheUsage;
  });
  try {
    await client.executeCommand({
      argv: [],
      clientInvocationId: crypto.randomUUID(),
      commandId: "status",
      path: ["status"],
      raw: "/status",
      rawArgs: "",
      sessionId: "s",
      surface: "tui",
    });
    return usage;
  } finally {
    unsubscribe();
  }
}
