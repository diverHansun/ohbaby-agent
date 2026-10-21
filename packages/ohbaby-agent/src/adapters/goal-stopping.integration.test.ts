import { afterEach, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/index.js";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "ohbaby-llm";
import { InMemoryGoalPersistence } from "../goals/persistence.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";
import {
  createInProcessUiBackendClient,
  type InProcessUiBackendOptions,
} from "./ui-inprocess.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: ReturnType<typeof createInProcessUiBackendClient>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture(
  stream: (
    request: InterfaceProviderRequest,
  ) => AsyncIterable<InterfaceProviderStreamEvent>,
  options: InProcessUiBackendOptions = {},
  wallClockBudgetMs = 1000,
) {
  const persistence = new InMemoryGoalPersistence();
  await persistence.append("one", {
    type: "create",
    goalId: "goal",
    objective: "Deadline fixture",
    budgetLimits: { wallClockBudgetMs },
  });
  await persistence.append("one", {
    type: "update",
    goalId: "goal",
    status: "paused",
  });
  const requests: InterfaceProviderRequest[] = [];
  const client = createInProcessUiBackendClient({
    initialSnapshot: {
      activeSessionId: "one",
      permissions: [],
      runs: [],
      status: { kind: "idle" },
      sessions: [
        {
          id: "one",
          title: "Existing",
          messages: [],
          createdAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
        },
      ],
    },
    llmClient: {
      config: {
        provider: "fixture",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "https://fixture.invalid",
        maxTokens: 128,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          requests.push(request);
          return Promise.resolve(stream(request));
        },
      },
    },
    ...options,
    goalPersistence: persistence,
  });
  clients.push(client);
  await client.initializeSession("one");
  return { client, persistence, requests };
}
function command(
  client: ReturnType<typeof createInProcessUiBackendClient>,
  rawArgs: string,
) {
  return client.executeCommand({
    commandId: "goal",
    path: ["goal"],
    clientInvocationId: crypto.randomUUID(),
    raw: `/goal ${rawArgs}`,
    rawArgs,
    argv: rawArgs.split(/\s+/),
    sessionId: "one",
    surface: "web",
  });
}
async function* output(): AsyncGenerator<InterfaceProviderStreamEvent> {
  await Promise.resolve();
  yield { textDelta: "USER_OK", finishReason: "stop" };
}

it.each(["before-bind", "before-start", "run-ready"] as const)(
  "3-D8 deadline cancels actual admitted execution in %s window without harming its user successor",
  async (stage) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let clock = 0;
    const entered = deferred();
    const release = deferred();
    let held = false;
    class PreparingAgentManager extends AgentManager {
      override async getRuntimeAgent(
        ...args: Parameters<AgentManager["getRuntimeAgent"]>
      ): ReturnType<AgentManager["getRuntimeAgent"]> {
        if (stage === "before-start" && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return super.getRuntimeAgent(...args);
      }
    }
    if (stage === "run-ready") {
      const composition = await import("./ui-runtime/composition.js");
      const create = composition.createUiRuntimeComposition;
      vi.spyOn(composition, "createUiRuntimeComposition").mockImplementation(
        async (options) => {
          const runtime = await create(options);
          return {
            ...runtime,
            async startSession(input) {
              const result = await runtime.startSession(input);
              if (!held) {
                held = true;
                entered.resolve();
                await release.promise;
              }
              return result;
            },
          };
        },
      );
    }
    const providerStarted = deferred();
    const fixtureState = await fixture(
      async function* (request) {
        const isUser = JSON.stringify(request.messages).includes(
          "successor user",
        );
        if (stage === "run-ready" && !isUser) {
          providerStarted.resolve();
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else
              request.signal?.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                {
                  once: true,
                },
              );
          });
        }
        yield* output();
      },
      {
        agentManager: new PreparingAgentManager(),
        now: () => new Date(clock),
        beforePromptSubmit: async () => {
          if (stage === "before-bind" && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
        },
      },
    );
    const { client, persistence, requests } = fixtureState;
    try {
      expect((await command(client, "resume")).status).toBe("completed");
      await entered.promise;
      if (stage === "run-ready") await providerStarted.promise;
      clock = 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        (await persistence.list("one")).filter((row) => row.status).at(-1)
          ?.status,
      ).toBe("blocked");
      expect(
        (await persistence.list("one"))
          .filter((row) => row.turnsUsed !== undefined)
          .map((row) => row.turnsUsed),
      ).toEqual([1]);
      expect(requests).toHaveLength(stage === "run-ready" ? 1 : 0);
      const user = await client.submitPromptAccepted("successor user", {
        sessionId: "one",
      });
      release.resolve();
      const completed = await client.waitForPrompt(user.promptId);
      expect(completed.prompt.status).toBe("succeeded");
      expect(requests.at(-1)?.signal?.aborted).toBe(false);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
        "successor user",
      );
      expect(requests).toHaveLength(stage === "run-ready" ? 2 : 1);
      if (stage === "run-ready")
        expect(requests[0]?.signal?.aborted).toBe(true);
      expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(
        "blocked",
      );
    } finally {
      release.resolve();
    }
  },
  10_000,
);

it("3-D4/D7 blocks a waiting goal while the existing user keeps execution and consumes no goal turn", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let clock = 0;
  const entered = deferred();
  const release = deferred();
  const { client, persistence, requests } = await fixture(
    async function* () {
      entered.resolve();
      await release.promise;
      yield* output();
    },
    { now: () => new Date(clock) },
  );
  try {
    const user = await client.submitPromptAccepted("existing user", {
      sessionId: "one",
    });
    await entered.promise;
    await command(client, "resume");
    clock = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(
      "blocked",
    );
    expect(requests[0]?.signal?.aborted).toBe(false);
    expect(
      (await persistence.list("one")).some(
        (row) => row.turnsUsed !== undefined,
      ),
    ).toBe(false);
    release.resolve();
    expect((await client.waitForPrompt(user.promptId)).prompt.status).toBe(
      "succeeded",
    );
    clock = 5000;
    await vi.advanceTimersByTimeAsync(4000);
    expect(requests).toHaveLength(1);
    expect(
      (await persistence.list("one")).filter((row) => row.status === "blocked"),
    ).toHaveLength(1);
    expect(
      (await persistence.list("one")).find((row) => row.status === "blocked")
        ?.wallClockMs,
    ).toBe(1000);
  } finally {
    release.resolve();
  }
}, 10_000);

it.each(["deadline", "watchdog"] as const)(
  "3-X1 production idle watchdog and deadline keep the first committed %s stop",
  async (first) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let clock = 0;
    const started = deferred();
    const { client, persistence } = await fixture(
      async function* () {
        // A partial response disables retries; next() deliberately ignores abort.
        yield { textDelta: "working" };
        // Signal the outstanding next(), after the consumer handled the event.
        started.resolve();
        await new Promise<void>(() => undefined);
      },
      { now: () => new Date(clock) },
      first === "deadline" ? 1000 : DEFAULT_STREAM_IDLE_TIMEOUT_MS * 2,
    );
    const stopped = deferred();
    const unsubscribe = client.subscribeEvents((event) => {
      if (
        event.type === "goal.updated" &&
        (event.goal?.status === "blocked" || event.goal?.status === "paused")
      )
        stopped.resolve();
    });
    await command(client, "resume");
    await started.promise;
    clock = first === "deadline" ? 1000 : DEFAULT_STREAM_IDLE_TIMEOUT_MS + 1;
    await vi.advanceTimersByTimeAsync(clock);
    // Runtime finalization includes real I/O, beyond fake timer/microtask flushing.
    await stopped.promise;
    unsubscribe();
    const expected = first === "deadline" ? "blocked" : "paused";
    expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(expected);
    clock += DEFAULT_STREAM_IDLE_TIMEOUT_MS * 3;
    await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS * 3);
    expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(expected);
    const stops = (await persistence.list("one")).filter(
      (row) => row.status === "blocked" || row.status === "paused",
    );
    expect(stops.map((row) => row.status)).toEqual(["paused", expected]);
  },
  10_000,
);
