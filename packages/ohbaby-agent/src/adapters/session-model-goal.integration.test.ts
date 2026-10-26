import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { InMemoryGoalPersistence } from "../goals/index.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

type Client = ReturnType<typeof createInProcessUiBackendClient>;
const clients: Client[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "T12c keeps the active model for steer=%s and resolves a new model for automatic continuation",
  async (steer) => {
    const directory = await mkdtemp(join(tmpdir(), "session-model-goal-"));
    directories.push(directory);
    const home = join(directory, "config");
    await mkdir(home);
    vi.stubEnv("OHBABY_HOME", home);
    await writeFile(
      join(home, "model.json"),
      JSON.stringify({
        activeProfileId: "a",
        models: ["a", "b"].map((id) => ({
          id,
          provider: id,
          model: `model-${id}`,
          baseUrl: `https://${id}.invalid/v1`,
          interfaceProvider: "openai-compatible",
          contextWindowTokens: 128000,
          maxOutputTokens: 8192,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        })),
      }),
    );
    const entered = deferred();
    const release = deferred();
    const persistence = new InMemoryGoalPersistence();
    const calls: { provider: string; request: InterfaceProviderRequest }[] = [];
    const client = createInProcessUiBackendClient({
      workdir: directory,
      projectDirectory: directory,
      goalPersistence: persistence,
      initialSnapshot: {
        activeSessionId: "goal-model",
        permissions: [],
        runs: [],
        status: { kind: "idle" },
        sessions: [
          {
            id: "goal-model",
            title: "Existing goal model session",
            modelEntryId: "a",
            messages: [],
            createdAt: "2026-10-26T00:00:00.000Z",
            updatedAt: "2026-10-26T00:00:00.000Z",
          },
        ],
      },
      createLLMClient: (config): Promise<LLMClientInstance> =>
        Promise.resolve({
          config,
          provider: {
            id: config.provider,
            kind: config.interfaceProvider,
            client: {},
            isAbortError: () => false,
            streamResponse(
              request,
            ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
              const index = calls.length;
              calls.push({ provider: config.provider, request });
              return Promise.resolve(
                (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                  if (index === 0) {
                    entered.resolve();
                    await release.promise;
                    yield {
                      textDelta: "First goal step complete.",
                      finishReason: "stop",
                    };
                  } else if (index === 1) {
                    yield {
                      toolCallDeltas: [
                        {
                          index: 0,
                          id: "finish_goal",
                          name: "UpdateGoal",
                          argumentsDelta: JSON.stringify({
                            status: "complete",
                          }),
                        },
                      ],
                      finishReason: "tool_calls",
                    };
                  } else if (index === 2) {
                    yield { textDelta: "Goal complete.", finishReason: "stop" };
                  } else
                    throw new Error(
                      "Unexpected goal continuation after completion",
                    );
                })(),
              );
            },
          },
        }),
    });
    clients.push(client);
    try {
      const objective = "Finish the bounded model inheritance fixture";
      await client.executeCommand({
        argv: [objective],
        clientInvocationId: crypto.randomUUID(),
        commandId: "goal",
        path: ["goal"],
        raw: `/goal ${objective}`,
        rawArgs: objective,
        sessionId: "goal-model",
        surface: "tui",
      });
      await entered.promise;
      const originalRun = client.getActiveGoalRunForSteer("goal-model");
      await client.updateSessionModel({
        sessionId: "goal-model",
        modelEntryId: "b",
      });
      if (steer) {
        const receipt = await client.submitPromptAccepted(
          "Include the lantern detail in this turn",
          {
            sessionId: "goal-model",
            modelEntryId: "b",
            clientRequestId: "model-goal-steer",
          },
        );
        expect(receipt).toMatchObject({
          status: "steered",
          steer: { receipt: { acceptedTargetRunId: originalRun?.runId } },
        });
        expect(
          (await client.waitForPrompt(receipt.promptId)).prompt.status,
        ).toBe("steered");
      }
      release.resolve();
      await vi.waitFor(async () => {
        expect((await persistence.list("goal-model")).at(-1)?.type).toBe(
          "clear",
        );
        expect(calls).toHaveLength(3);
      });
      expect(calls.map((call) => call.provider)).toEqual(
        steer ? ["a", "a", "a"] : ["a", "b", "b"],
      );
      if (steer)
        expect(JSON.stringify(calls[1].request.messages)).toContain(
          "Include the lantern detail in this turn",
        );
      const turnCounts = (await persistence.list("goal-model")).flatMap(
        (record) => (record.turnsUsed === undefined ? [] : [record.turnsUsed]),
      );
      expect(Math.max(...turnCounts)).toBe(steer ? 1 : 2);
    } finally {
      release.resolve();
    }
  },
);
