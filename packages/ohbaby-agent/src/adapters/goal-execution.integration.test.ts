import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import {
  createInProcessUiBackendClient,
  type InProcessUiBackendOptions,
} from "./ui-inprocess.js";
import { InMemoryGoalPersistence } from "../goals/index.js";
import { InMemoryPromptSubmissionStore } from "../runtime/prompt-scheduler/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../services/interface-providers/index.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: ReturnType<typeof createInProcessUiBackendClient>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  vi.restoreAllMocks();
});

function fixture(
  stream: (
    request: InterfaceProviderRequest,
    index: number,
  ) => AsyncIterable<InterfaceProviderStreamEvent>,
  options: InProcessUiBackendOptions = {},
): {
  client: ReturnType<typeof createInProcessUiBackendClient>;
  persistence: NonNullable<InProcessUiBackendOptions["goalPersistence"]>;
  prompts: NonNullable<InProcessUiBackendOptions["promptSubmissionStore"]>;
  requests: InterfaceProviderRequest[];
  events: UiEvent[];
} {
  const persistence = options.goalPersistence ?? new InMemoryGoalPersistence();
  const prompts =
    options.promptSubmissionStore ?? new InMemoryPromptSubmissionStore();
  const requests: InterfaceProviderRequest[] = [];
  const events: UiEvent[] = [];
  const client = createInProcessUiBackendClient({
    initialSnapshot: {
      activeSessionId: "one",
      permissions: [],
      runs: [],
      status: { kind: "idle" },
      sessions: ["one", "two"].map((id) => ({
        id,
        title: "Existing",
        messages: [],
        createdAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
      })),
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
          if (request.purpose === "session-title")
            return Promise.resolve(output());
          requests.push(request);
          return Promise.resolve(stream(request, requests.length - 1));
        },
      },
    },
    ...options,
    goalPersistence: persistence,
    promptSubmissionStore: prompts,
  });
  clients.push(client);
  client.subscribeEvents((event) => events.push(event));
  return { client, persistence, prompts, requests, events };
}
async function* output(): AsyncGenerator<InterfaceProviderStreamEvent> {
  await Promise.resolve();
  yield { textDelta: "Done.", finishReason: "stop" };
}
function tool(name: string, args: unknown): InterfaceProviderStreamEvent {
  return {
    toolCallDeltas: [
      {
        index: 0,
        id: `call_${name}`,
        name,
        argumentsDelta: JSON.stringify(args),
      },
    ],
    finishReason: "tool_calls",
  };
}
async function command(
  client: ReturnType<typeof createInProcessUiBackendClient>,
  args: string[],
  sessionId = "one",
): ReturnType<typeof client.executeCommand> {
  return client.executeCommand({
    argv: args,
    clientInvocationId: crypto.randomUUID(),
    commandId: "goal",
    path: ["goal"],
    raw: `/goal ${args.join(" ")}`,
    rawArgs: args.join(" "),
    sessionId,
    surface: "tui",
  });
}

describe("goal execution admission and settlement", () => {
  it("G1/G3 queues user work without interrupting the goal, then runs users before another goal turn", async () => {
    const started = deferred();
    const finish = deferred();
    const order: string[] = [];
    let signal: AbortSignal | undefined;
    const { client, prompts, persistence } = fixture(
      async function* (request, index) {
        order.push(request.sessionId ?? "unknown");
        if (index === 0) {
          signal = request.signal;
          started.resolve();
          await finish.promise;
          yield { textDelta: "First goal turn done.", finishReason: "stop" };
        } else if (index === 3)
          yield tool("UpdateGoal", { status: "complete" });
        else yield { textDelta: "Done.", finishReason: "stop" };
      },
    );
    try {
      await command(client, ["finish the admission fixture"]);
      await started.promise;
      const user = await client.submitPromptAccepted("queued user", {
        sessionId: "one",
      });
      const other = await client.submitPromptAccepted("independent user", {
        sessionId: "two",
      });
      await client.waitForPrompt(other.promptId);
      expect((await prompts.get(user.promptId))?.status).toBe("queued");
      expect(signal?.aborted).toBe(false);
      expect(order.slice(0, 2)).toEqual(["one", "two"]);
      expect(
        (await persistence.list("one"))
          .filter((r) => r.turnsUsed !== undefined)
          .at(-1)?.turnsUsed,
      ).toBe(1);
      finish.resolve();
      await client.waitForPrompt(user.promptId);
      expect((await prompts.get(user.promptId))?.status).toBe("succeeded");
      await vi.waitFor(async () => {
        expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
      });
      expect(order).toEqual(["one", "two", "one", "one", "one"]);
    } finally {
      finish.resolve();
    }
  });
});

function usage(
  total: number,
  cached?: number,
): NonNullable<InterfaceProviderStreamEvent["tokenUsage"]> {
  return {
    inputTokens: total - 10,
    outputTokens: 10,
    totalTokens: total,
    ...(cached === undefined
      ? {}
      : {
          inputBreakdown: {
            uncached: total - 10 - cached,
            cacheRead: cached,
            cacheWrite: 0,
            observed: { cacheRead: true, cacheWrite: true },
          },
        }),
  };
}

it("G14/G18 completes visibly once before settling the tail and emits progress without notices", async () => {
  const tail = deferred();
  const finish = deferred();
  const { client, persistence, events } = fixture(
    async function* (_request, index) {
      if (index === 0)
        yield {
          ...tool("UpdateGoal", { status: "complete" }),
          tokenUsage: usage(100, 80),
        };
      else {
        tail.resolve();
        await finish.promise;
        yield {
          textDelta: "Completed.",
          finishReason: "stop",
          tokenUsage: usage(50, 20),
        };
      }
    },
  );
  try {
    await command(client, ["finish a durable goal"]);
    await tail.promise;
    expect((await client.getSnapshot()).goals ?? []).toEqual([]);
    const before = await persistence.list("one");
    expect(before.at(-1)?.status).toBe("complete");
    expect(before.some((r) => r.type === "clear")).toBe(false);
    expect(
      events.filter(
        (e) => e.type === "notice.emitted" && e.notice.source === "goals",
      ),
    ).toHaveLength(2);
    finish.resolve();
    await vi.waitFor(async () => {
      expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
    });
    const after = await persistence.list("one");
    expect(
      after.filter((r) => r.tokensUsed !== undefined).at(-1),
    ).toMatchObject({
      tokensUsed: 150,
      cachedTokensUsed: 100,
      usageIncomplete: false,
    });
    expect(
      events.filter(
        (e) =>
          e.type === "notice.emitted" && e.notice.message === "Goal completed.",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (e) => e.type === "notice.emitted" && e.notice.source === "goals",
      ),
    ).toHaveLength(2);
  } finally {
    finish.resolve();
  }
});

it.each(["usage", "clear"] as const)(
  "G21 recovers %s append through initializeSession exactly once before queued users",
  async (stage) => {
    const persistence = new InMemoryGoalPersistence();
    const append = persistence.append.bind(persistence);
    const saving = deferred();
    const releaseSave = deferred();
    let writable = false;
    persistence.append = async (sessionId, data): Promise<void> => {
      if (
        data.type === (stage === "clear" ? "clear" : "update") &&
        (stage === "clear" || data.tokensUsed === 150)
      ) {
        saving.resolve();
        await releaseSave.promise;
        if (!writable) throw new Error(`${stage} unavailable`);
      }
      await append(sessionId, data);
    };
    const { client, prompts, requests } = fixture(
      async function* (_request, index) {
        await Promise.resolve();
        if (index === 0)
          yield {
            ...tool("UpdateGoal", { status: "complete" }),
            tokenUsage: usage(100, 80),
          };
        else
          yield {
            textDelta: "Done.",
            finishReason: "stop",
            tokenUsage: usage(50, 20),
          };
      },
      { goalPersistence: persistence },
    );
    try {
      await command(client, ["complete with a recoverable write"]);
      await saving.promise;
      // Already accepted work cannot take the lease while settlement owns the session.
      const queued = (
        await prompts.accept({
          promptId: "queued",
          clientRequestId: "queued",
          scopeKey: process.cwd(),
          sessionId: "one",
          userMessageId: "queued-message",
          text: "user after recovery",
          maxQueuedPrompts: 100,
        })
      ).record;
      expect((await prompts.get(queued.promptId))?.status).toBe("queued");
      releaseSave.resolve();
      await vi.waitFor(async () => {
        expect(
          (await client.getSessionControl({ sessionId: "one" }))
            .executionRecovery?.status,
        ).toBe("blocked");
      });
      await expect(client.initializeSession("one")).rejects.toThrow(
        `${stage} unavailable`,
      );
      expect(requests).toHaveLength(2);
      writable = true;
      await Promise.all([
        client.initializeSession("one"),
        client.initializeSession("one"),
      ]);
      await client.waitForPrompt(queued.promptId);
      const records = await persistence.list("one");
      expect(records.filter((r) => r.tokensUsed === 150)).toHaveLength(1);
      expect(records.filter((r) => r.cachedTokensUsed === 100)).toHaveLength(1);
      expect(records.filter((r) => r.type === "clear")).toHaveLength(1);
      expect(
        (await client.getSessionControl({ sessionId: "one" })).executionRecovery
          ?.status,
      ).toBe("ready");
    } finally {
      writable = true;
      releaseSave.resolve();
    }
  },
);

it.each(["pause", "cancel"])(
  "G7/G24 %s cancels an admitted preparation without starting its provider",
  async (action) => {
    const preparing = deferred();
    const release = deferred();
    let preparations = 0;
    const { client, persistence, requests } = fixture(() => output(), {
      beforePromptSubmit: async () => {
        if (++preparations === 1) {
          preparing.resolve();
          await release.promise;
        }
      },
    });
    try {
      await command(client, ["prepare this goal"]);
      await preparing.promise;
      await command(client, [action]);
      const user = await client.submitPromptAccepted("user after stop", {
        sessionId: "one",
      });
      expect(requests).toHaveLength(0);
      expect(
        (await persistence.list("one"))
          .filter((r) => r.turnsUsed !== undefined)
          .at(-1)?.turnsUsed,
      ).toBe(1);
      release.resolve();
      await client.waitForPrompt(user.promptId);
      expect(requests).toHaveLength(1);
    } finally {
      release.resolve();
    }
  },
);

it.each(["pause", "cancel", "replace"])(
  "G6/G9 %s while waiting behind a user does not count an old goal turn",
  async (action) => {
    const started = deferred();
    const finish = deferred();
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        if (index === 0) {
          started.resolve();
          await finish.promise;
          yield { textDelta: "User done", finishReason: "stop" };
        } else if (index === 1)
          yield tool("UpdateGoal", { status: "complete" });
        else yield { textDelta: "Done", finishReason: "stop" };
      },
    );
    try {
      const user = await client.submitPromptAccepted("user owns execution", {
        sessionId: "one",
      });
      await started.promise;
      await command(client, ["old objective"]);
      await command(
        client,
        action === "replace" ? ["replace", "new objective"] : [action],
      );
      expect(
        (await persistence.list("one")).filter(
          (r) => r.turnsUsed !== undefined,
        ),
      ).toEqual([]);
      finish.resolve();
      await client.waitForPrompt(user.promptId);
      if (action === "replace") {
        await vi.waitFor(async () => {
          expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
        });
        expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain(
          "new objective",
        );
        expect(
          (await persistence.list("one"))
            .filter((r) => r.turnsUsed !== undefined)
            .map((r) => r.turnsUsed),
        ).toEqual([1]);
      } else expect(requests).toHaveLength(1);
    } finally {
      finish.resolve();
    }
  },
);

it("G21 keeps a waiting goal unadmitted until user runtime finalization is explicitly recovered", async () => {
  const { createInMemoryRunLedger } =
    await import("../runtime/run-ledger/index.js");
  const ledger = createInMemoryRunLedger();
  const mark = ledger.markSucceeded.bind(ledger);
  let writable = false;
  ledger.markSucceeded = async (runId, terminal): ReturnType<typeof mark> => {
    if (runId === "blocked-user-run" && !writable)
      throw new Error("user runtime finalization unavailable");
    return mark(runId, terminal);
  };
  const userStarted = deferred();
  const finishUser = deferred();
  let ids = 0;
  const { client, persistence, prompts, requests } = fixture(
    async function* (_request, index) {
      if (index === 0) {
        userStarted.resolve();
        await finishUser.promise;
      }
      if (index === 1) yield tool("UpdateGoal", { status: "complete" });
      else yield { textDelta: "Finished", finishReason: "stop" };
    },
    {
      runLedger: ledger,
      createRunId: () =>
        ++ids === 1 ? "blocked-user-run" : `goal-run-${String(ids)}`,
    },
  );
  try {
    const user = await client.submitPromptAccepted("user before goal", {
      sessionId: "one",
    });
    await userStarted.promise;
    await command(client, ["goal waits for user runtime recovery"]);
    finishUser.resolve();
    await vi.waitFor(async () => {
      expect(
        (await client.getSessionControl({ sessionId: "one" })).executionRecovery
          ?.status,
      ).toBe("blocked");
    });
    expect(requests).toHaveLength(1);
    expect((await client.getSnapshot()).goals?.[0]?.goal).toMatchObject({
      status: "active",
    });
    expect(
      (await persistence.list("one")).filter(
        (record) => record.turnsUsed !== undefined,
      ),
    ).toEqual([]);
    writable = true;
    await client.initializeSession("one");
    await client.waitForPrompt(user.promptId);
    await vi.waitFor(async () => {
      expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
    });
    expect((await ledger.get("blocked-user-run"))?.status).toBe("succeeded");
    expect((await prompts.get(user.promptId))?.status).toBe("succeeded");
    expect(
      (await persistence.list("one"))
        .filter((record) => record.turnsUsed !== undefined)
        .map((record) => record.turnsUsed),
    ).toEqual([1]);
    expect(requests).toHaveLength(3);
  } finally {
    finishUser.resolve();
    writable = true;
  }
});

it("G21 preserves runtime completion across later usage recovery failure", async () => {
  const { createInMemoryRunLedger } =
    await import("../runtime/run-ledger/index.js");
  const ledger = createInMemoryRunLedger();
  const mark = ledger.markSucceeded.bind(ledger);
  let runtimeWritable = false;
  let runtimeWrites = 0;
  ledger.markSucceeded = async (runId, terminal): ReturnType<typeof mark> => {
    if (runId === "goal-run") {
      runtimeWrites++;
      if (!runtimeWritable) throw new Error("runtime finalization unavailable");
    }
    return mark(runId, terminal);
  };
  const persistence = new InMemoryGoalPersistence();
  const append = persistence.append.bind(persistence);
  let usageWritable = false;
  persistence.append = async (sid, record): Promise<void> => {
    if (record.tokensUsed === 150 && !usageWritable)
      throw new Error("usage unavailable");
    await append(sid, record);
  };
  let ids = 0;
  const { client, prompts, requests } = fixture(
    async function* (_request, index) {
      await Promise.resolve();
      if (index === 0)
        yield {
          ...tool("UpdateGoal", { status: "complete" }),
          tokenUsage: usage(100, 80),
        };
      else
        yield {
          textDelta: "Done",
          finishReason: "stop",
          tokenUsage: usage(50, 20),
        };
    },
    {
      runLedger: ledger,
      goalPersistence: persistence,
      createRunId: () => (++ids === 1 ? "goal-run" : "user-run"),
    },
  );
  await command(client, ["recover finalization then usage"]);
  await vi.waitFor(async () => {
    expect(
      (await client.getSessionControl({ sessionId: "one" })).executionRecovery
        ?.status,
    ).toBe("blocked");
  });
  expect((await persistence.list("one")).at(-1)?.status).toBe("complete");
  const queued = (
    await prompts.accept({
      promptId: "recover-user",
      clientRequestId: "recover-user",
      scopeKey: process.cwd(),
      sessionId: "one",
      userMessageId: "recover-user-message",
      text: "user",
      maxQueuedPrompts: 100,
    })
  ).record;
  runtimeWritable = true;
  await expect(client.initializeSession("one")).rejects.toThrow(
    "usage unavailable",
  );
  expect((await ledger.get("goal-run"))?.status).toBe("succeeded");
  expect((await prompts.get(queued.promptId))?.status).toBe("queued");
  const completedWrites = runtimeWrites;
  usageWritable = true;
  await client.initializeSession("one");
  await client.waitForPrompt(queued.promptId);
  expect(runtimeWrites).toBe(completedWrites);
  expect(
    (await persistence.list("one")).filter((r) => r.tokensUsed === 150),
  ).toHaveLength(1);
  expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
  expect(requests).toHaveLength(3);
});

it.each(["failed", "cancelled"])(
  "G17 retains known total/cache usage from a %s run",
  async (status) => {
    const second = deferred();
    const { client, persistence } = fixture(async function* (request, index) {
      if (index === 0) {
        yield { ...tool("GetGoal", {}), tokenUsage: usage(100, 80) };
        return;
      }
      second.resolve();
      if (status === "cancelled")
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
      yield { textDelta: "partial" };
      throw new Error("Unauthorized fixture failure");
    });
    await command(client, ["report partial usage"]);
    await second.promise;
    if (status === "cancelled") await command(client, ["pause"]);
    await vi.waitFor(async () => {
      expect(
        (await persistence.list("one")).some((r) => r.tokensUsed === 100),
      ).toBe(true);
    });
    expect(
      (await persistence.list("one"))
        .filter((r) => r.tokensUsed !== undefined)
        .at(-1),
    ).toMatchObject({
      tokensUsed: 100,
      cachedTokensUsed: 80,
      usageIncomplete: true,
    });
    expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe("paused");
  },
);

it.each(["failed", "complete", "known-zero"] as const)(
  "G17 keeps missing usage absent instead of recording a fabricated zero (%s)",
  async (scenario) => {
    const { client, persistence } = fixture(async function* (_request, index) {
      await Promise.resolve();
      if (scenario === "failed")
        throw new Error("Unauthorized fixture failure");
      const event =
        index === 0
          ? tool("UpdateGoal", { status: "complete" })
          : { textDelta: "Done", finishReason: "stop" as const };
      yield scenario === "known-zero"
        ? {
            ...event,
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          }
        : event;
    });
    await command(client, ["check missing usage"]);
    await vi.waitFor(async () => {
      expect(
        (await persistence.list("one")).some(
          (record) => record.usageIncomplete === true,
        ),
      ).toBe(true);
    });
    const settled = (await persistence.list("one")).find(
      (record) => record.usageIncomplete === true,
    );
    expect(settled?.tokensUsed).toBe(scenario === "known-zero" ? 0 : undefined);
    expect(settled?.cachedTokensUsed).toBeUndefined();
  },
);

it.each([
  ["UpdateGoal", { status: "complete" }],
  ["SetGoalBudget", { value: 1, unit: "turns" }],
  ["CreateGoal", { objective: "evil replacement", replace: true }],
] as const)(
  "G26/G27 rejects stale %s after objective editing while retaining same-goal usage",
  async (name, args) => {
    const started = deferred();
    const finish = deferred();
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        if (index === 0) {
          started.resolve();
          await finish.promise;
          yield { ...tool(name, args), tokenUsage: usage(100, 80) };
        } else if (index === 2)
          yield tool("UpdateGoal", { status: "complete" });
        else yield { textDelta: "Done", finishReason: "stop" };
      },
    );
    try {
      await command(client, ["old objective"]);
      await started.promise;
      const original = (await persistence.list("one"))[0]?.goalId;
      await command(client, ["replace", "new objective"]);
      finish.resolve();
      await vi.waitFor(async () => {
        expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
      });
      expect(
        new Set((await persistence.list("one")).map((r) => r.goalId)),
      ).toEqual(new Set([original]));
      expect(JSON.stringify(requests[1]?.messages)).toContain(
        "no longer has permission",
      );
      expect(JSON.stringify(requests[2]?.messages.at(-1))).toContain(
        "new objective",
      );
      expect(
        (await persistence.list("one"))
          .filter((r) => r.turnsUsed !== undefined)
          .map((r) => r.turnsUsed),
      ).toEqual([1, 2]);
      expect(
        (await persistence.list("one"))
          .filter((r) => r.tokensUsed !== undefined)
          .at(-1)?.tokensUsed,
      ).toBe(100);
    } finally {
      finish.resolve();
    }
  },
);

it("G27 authorizes all goal tools from an ordinary user primary run", async () => {
  const { GoalService } = await import("../goals/index.js");
  const create = vi.spyOn(GoalService.prototype, "createGoal");
  const budget = vi.spyOn(GoalService.prototype, "setBudget");
  const update = vi.spyOn(GoalService.prototype, "updateGoalFromModel");
  const calls = [
    tool("CreateGoal", { objective: "user requested goal" }),
    tool("SetGoalBudget", { unit: "turns", value: 4 }),
    tool("GetGoal", {}),
    tool("UpdateGoal", { status: "complete" }),
  ];
  const { client, persistence, prompts, requests } = fixture(
    async function* (_request, index) {
      yield await Promise.resolve(
        calls[index] ?? { textDelta: "User finished", finishReason: "stop" },
      );
    },
    { createRunId: () => "authorized-user-run" },
  );
  const user = await client.submitPromptAccepted(
    "Create the requested goal with a four-turn limit, then complete it",
    { sessionId: "one" },
  );
  await client.waitForPrompt(user.promptId);
  expect((await prompts.get(user.promptId))?.status).toBe("succeeded");
  expect(create).toHaveBeenCalledWith(
    "one",
    expect.objectContaining({
      actor: "model",
      objective: "user requested goal",
    }),
    "authorized-user-run",
  );
  expect(budget).toHaveBeenCalledWith(
    "one",
    { turnBudget: 4 },
    "authorized-user-run",
  );
  expect(update).toHaveBeenCalledWith(
    "one",
    "complete",
    undefined,
    "authorized-user-run",
  );
  const records = await persistence.list("one");
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "create",
        objective: "user requested goal",
      }),
      expect.objectContaining({ budgetLimits: { turnBudget: 4 } }),
      expect.objectContaining({ status: "complete" }),
    ]),
  );
  expect(records.at(-1)?.type).toBe("clear");
  expect(records.filter((record) => record.turnsUsed !== undefined)).toEqual(
    [],
  );
  expect(requests).toHaveLength(5);
  expect(JSON.stringify(requests[3]?.messages)).toContain(
    "turns remaining 4/4",
  );
  expect(JSON.stringify(requests[4]?.messages)).toContain("Goal completed.");
});

it.each([
  ["CreateGoal", { objective: "unauthorized replacement", replace: true }],
  ["SetGoalBudget", { unit: "turns", value: 1 }],
  ["UpdateGoal", { status: "complete" }],
] as const)(
  "G27 rejects %s from missing, unknown and actual child run identities while GetGoal stays readable",
  async (name, args) => {
    const { GoalService, createGoalTools } = await import("../goals/index.js");
    const { createInMemoryRunLedger } =
      await import("../runtime/run-ledger/index.js");
    const create = vi.spyOn(GoalService.prototype, "createGoal");
    const ledger = createInMemoryRunLedger();
    const childStarted = deferred();
    const finishChild = deferred();
    let parentSteps = 0;
    const { client, persistence } = fixture(
      async function* (request) {
        if (JSON.stringify(request.messages).includes("Task: explore")) {
          childStarted.resolve();
          await finishChild.promise;
          yield { textDelta: "Child finished", finishReason: "stop" };
          return;
        }
        parentSteps++;
        if (parentSteps === 1)
          yield tool("CreateGoal", { objective: "protected user goal" });
        else if (parentSteps === 2)
          yield tool("subagent_run", {
            role: "explore",
            mode: "foreground",
            prompt: "Explore the authorization fixture",
            description: "goal mutation authorization",
          });
        else if (parentSteps === 3)
          yield tool("UpdateGoal", { status: "complete" });
        else yield { textDelta: "Parent finished", finishReason: "stop" };
      },
      { runLedger: ledger },
    );
    try {
      const user = await client.submitPromptAccepted(
        "create goal then delegate",
        {
          sessionId: "one",
        },
      );
      await childStarted.promise;
      const service = create.mock.contexts[0];
      if (!(service instanceof GoalService))
        throw new Error("Expected live goal service");
      const activeRuns = await ledger.getActiveRuns();
      const child = activeRuns.find((run) => run.sessionId !== "one");
      expect(activeRuns).toHaveLength(2);
      if (!child) throw new Error("Expected active child run");
      const goalTools = createGoalTools(service);
      const mutation = goalTools.find((entry) => entry.name === name);
      const read = goalTools.find((entry) => entry.name === "GetGoal");
      if (!mutation || !read) throw new Error("Expected goal tools");
      const before = await persistence.list("one");
      for (const runId of [undefined, "unknown-run", child.runId]) {
        const context = {
          callId: "unauthorized-call",
          messageId: "unauthorized-message",
          sessionId: "one",
          signal: new AbortController().signal,
          ...(runId === undefined ? {} : { runId }),
        };
        await expect(mutation.execute(args, context)).rejects.toThrow(
          runId === undefined
            ? "trusted run identity"
            : "no longer has permission",
        );
        expect((await read.execute({}, context)).output).toContain(
          "protected user goal",
        );
        expect(await persistence.list("one")).toEqual(before);
      }
      finishChild.resolve();
      await client.waitForPrompt(user.promptId);
      expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
    } finally {
      finishChild.resolve();
    }
  },
);

it.each(["continue", "pause"] as const)(
  "G5 waits behind actual compact without counting, then %s",
  async (action) => {
    const { createBus } = await import("../bus/index.js");
    const { createMessageManager, createInMemoryMessageStore } =
      await import("../core/message/index.js");
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    for (const role of ["user", "assistant", "user"] as const) {
      const message = await messageManager.createMessage({
        agent: "test",
        sessionId: "one",
        role,
      });
      await messageManager.appendPart(message.id, {
        type: "text",
        text: "old context ".repeat(5000),
      });
    }
    const summarizing = deferred();
    const finishSummary = deferred();
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        if (index === 0) {
          summarizing.resolve();
          await finishSummary.promise;
          yield {
            textDelta: "<state_snapshot>compact summary</state_snapshot>",
            finishReason: "stop",
          };
        } else if (index === 1)
          yield tool("UpdateGoal", { status: "complete" });
        else yield { textDelta: "Finished", finishReason: "stop" };
      },
      { bus, messageManager },
    );
    const compact = client.compactSession({ sessionId: "one" });
    try {
      await summarizing.promise;
      await command(client, ["goal after compact"]);
      expect(requests).toHaveLength(1);
      expect(
        (await persistence.list("one")).filter(
          (record) => record.turnsUsed !== undefined,
        ),
      ).toEqual([]);
      expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(
        "active",
      );
      if (action === "pause") await command(client, ["pause"]);
      finishSummary.resolve();
      await expect(compact).resolves.toMatchObject({ status: "compacted" });
      if (action === "continue") {
        await vi.waitFor(async () => {
          expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
        });
        expect(
          (await persistence.list("one"))
            .filter((record) => record.turnsUsed !== undefined)
            .map((record) => record.turnsUsed),
        ).toEqual([1]);
        expect(JSON.stringify(requests[1]?.messages)).toContain(
          "compact summary",
        );
      } else {
        const user = await client.submitPromptAccepted(
          "user after paused compact",
          { sessionId: "one" },
        );
        await client.waitForPrompt(user.promptId);
        expect(
          (await persistence.list("one")).filter(
            (record) => record.turnsUsed !== undefined,
          ),
        ).toEqual([]);
        expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(
          "paused",
        );
      }
    } finally {
      finishSummary.resolve();
      await compact.catch(() => undefined);
    }
  },
);

it("G8 stops after admission and pause append failures, then explicit resume admits exactly once", async () => {
  const persistence = new InMemoryGoalPersistence();
  const append = persistence.append.bind(persistence);
  const pauseAttempted = deferred();
  let writable = false;
  let admissionAttempts = 0;
  let pauseAttempts = 0;
  persistence.append = async (sessionId, record): Promise<void> => {
    if (!writable && record.turnsUsed !== undefined) {
      admissionAttempts++;
      throw new Error("admission disk unavailable");
    }
    if (!writable && record.status === "paused") {
      pauseAttempts++;
      pauseAttempted.resolve();
      throw new Error("pause disk unavailable");
    }
    await append(sessionId, record);
  };
  const { client, requests, events } = fixture(
    async function* (_request, index) {
      await Promise.resolve();
      if (index === 0) yield tool("UpdateGoal", { status: "complete" });
      else yield { textDelta: "Done", finishReason: "stop" };
    },
    { goalPersistence: persistence },
  );
  await command(client, ["repairable goal"]);
  await pauseAttempted.promise;
  await client.getSnapshot();
  await client.getSessionControl({ sessionId: "one" });
  await client.getSessionView({ sessionId: "one" });
  expect(admissionAttempts).toBe(1);
  expect(pauseAttempts).toBe(1);
  expect(requests).toEqual([]);
  expect(
    (await persistence.list("one")).filter(
      (record) => record.turnsUsed !== undefined,
    ),
  ).toEqual([]);
  expect(
    events.some(
      (event) =>
        event.type === "notice.emitted" &&
        event.notice.level === "error" &&
        event.notice.message.includes("admission disk unavailable"),
    ),
  ).toBe(true);
  writable = true;
  await command(client, ["resume"]);
  await vi.waitFor(async () => {
    expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
  });
  expect(requests).toHaveLength(2);
  expect(
    (await persistence.list("one"))
      .filter((record) => record.turnsUsed !== undefined)
      .map((record) => record.turnsUsed),
  ).toEqual([1]);
});

it.each([
  { action: "resume", oldEnd: "pause" },
  { action: "new-goal", oldEnd: "throw" },
  { action: "new-goal", oldEnd: "pause" },
] as const)(
  "G10/G11 late failed result after $oldEnd cannot pause the $action lifecycle",
  async ({ action, oldEnd }) => {
    const { GoalService } = await import("../goals/index.js");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the actual service receiver below.
    const originalSettle = GoalService.prototype.settleTurn;
    const settlingOld = deferred();
    const releaseOldSettlement = deferred();
    let held = false;
    const settlement = vi
      .spyOn(GoalService.prototype, "settleTurn")
      .mockImplementation(async function (
        this: import("../goals/index.js").GoalService,
        sessionId,
        ticket,
        outcome,
      ) {
        if (!held) {
          held = true;
          settlingOld.resolve();
          await releaseOldSettlement.promise;
        }
        await originalSettle.call(this, sessionId, ticket, outcome);
      });
    const oldStarted = deferred();
    const lateFailure = deferred();
    const newStarted = deferred();
    const finishNew = deferred();
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        if (index === 0) {
          yield { ...tool("GetGoal", {}), tokenUsage: usage(100, 80) };
          return;
        }
        if (index === 1) {
          oldStarted.resolve();
          await lateFailure.promise;
          throw new Error("Unauthorized old lifecycle failure");
        }
        if (index === 2) {
          newStarted.resolve();
          await finishNew.promise;
          yield tool("UpdateGoal", { status: "complete" });
        } else yield { textDelta: "Done", finishReason: "stop" };
      },
    );
    let pause: Promise<unknown> | undefined;
    try {
      await command(client, ["resume identity goal"]);
      await oldStarted.promise;
      const oldGoalId = (await persistence.list("one"))[0]?.goalId;
      if (oldEnd === "pause") {
        pause = command(client, ["pause"]);
        await vi.waitFor(async () => {
          expect(
            (await persistence.list("one")).some(
              (record) => record.status === "paused",
            ),
          ).toBe(true);
        });
      } else lateFailure.resolve();
      await settlingOld.promise;
      expect(settlement.mock.calls[0]?.[2]).toMatchObject({
        status: "failed",
        usage: { totalTokens: 100, cachedInputTokens: 80 },
      });
      if (action === "resume") await command(client, ["resume"]);
      else {
        await command(client, ["cancel"]);
        await command(client, ["new identity goal"]);
        expect((await persistence.list("one")).at(-1)?.goalId).not.toBe(
          oldGoalId,
        );
      }
      lateFailure.resolve();
      releaseOldSettlement.resolve();
      await pause;
      await newStarted.promise;
      expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(
        "active",
      );
      expect(
        (await persistence.list("one")).filter(
          (record) => record.status === "paused",
        ),
      ).toHaveLength(oldEnd === "pause" ? 1 : 0);
      expect(
        (await persistence.list("one"))
          .filter((record) => record.turnsUsed !== undefined)
          .map((record) => record.turnsUsed),
      ).toEqual(action === "resume" ? [1, 2] : [1, 1]);
      finishNew.resolve();
      await vi.waitFor(async () => {
        expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
      });
      expect(requests).toHaveLength(4);
      if (action === "new-goal") {
        const records = await persistence.list("one");
        expect(
          records.filter((record) => record.type === "create"),
        ).toHaveLength(2);
        expect(
          records
            .filter(
              (record) =>
                record.goalId !== oldGoalId && record.tokensUsed !== undefined,
            )
            .map((record) => record.tokensUsed),
        ).toEqual([]);
      }
    } finally {
      releaseOldSettlement.resolve();
      lateFailure.resolve();
      finishNew.resolve();
      await pause;
    }
  },
);

it.each(["cancel", "new-goal"] as const)(
  "G21 repairs old runtime after %s during recovery without writing stale goal usage",
  async (action) => {
    const { createInMemoryRunLedger } =
      await import("../runtime/run-ledger/index.js");
    const ledger = createInMemoryRunLedger();
    const mark = ledger.markSucceeded.bind(ledger);
    let writable = false;
    let ids = 0;
    ledger.markSucceeded = async (runId, terminal): ReturnType<typeof mark> => {
      if (runId === "old-goal-run" && !writable)
        throw new Error("old runtime disk unavailable");
      return mark(runId, terminal);
    };
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        await Promise.resolve();
        if (index === 0)
          yield {
            ...tool("UpdateGoal", { status: "complete" }),
            tokenUsage: usage(100, 80),
          };
        else if (index === 1)
          yield {
            textDelta: "Old finished",
            finishReason: "stop",
            tokenUsage: usage(50, 20),
          };
        else if (index === 2 && action === "new-goal")
          yield tool("UpdateGoal", { status: "complete" });
        else yield { textDelta: "New finished", finishReason: "stop" };
      },
      {
        runLedger: ledger,
        createRunId: () =>
          ++ids === 1 ? "old-goal-run" : `next-run-${String(ids)}`,
      },
    );
    try {
      await command(client, ["old recoverable goal"]);
      await vi.waitFor(async () => {
        expect(
          (await client.getSessionControl({ sessionId: "one" }))
            .executionRecovery?.status,
        ).toBe("blocked");
      });
      const original = (await persistence.list("one"))[0]?.goalId;
      const mutation = await command(
        client,
        action === "cancel" ? ["cancel"] : ["new replacement goal"],
      );
      expect(JSON.stringify(mutation)).not.toContain(
        "old runtime disk unavailable",
      );
      expect(requests).toHaveLength(2);
      const beforeRepair = await persistence.list("one");
      expect(beforeRepair.at(-1)?.type).toBe(
        action === "cancel" ? "clear" : "create",
      );
      writable = true;
      await client.initializeSession("one");
      expect((await ledger.get("old-goal-run"))?.status).toBe("succeeded");
      if (action === "new-goal")
        await vi.waitFor(async () => {
          expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
        });
      const records = await persistence.list("one");
      expect(records.some((record) => record.tokensUsed === 150)).toBe(false);
      if (action === "new-goal") {
        expect(
          records.filter((record) => record.type === "create"),
        ).toHaveLength(2);
        expect(
          records.filter(
            (record) =>
              record.goalId !== original && record.tokensUsed !== undefined,
          ).length,
        ).toBe(0);
      } else expect((await client.getSnapshot()).goals ?? []).toEqual([]);
    } finally {
      writable = true;
    }
  },
);

it.each(["active", "complete"] as const)(
  "G12/G15/G19 replays %s admitted residue with legacy budget and rejects stale identity updates",
  async (status) => {
    const persistence = new InMemoryGoalPersistence();
    await persistence.append("one", {
      type: "create",
      goalId: "saved-goal",
      objective: "crashed after admission",
      budgetLimits: {
        turnBudget: 4,
        tokenBudget: 1,
      } as import("../goals/index.js").GoalBudgetLimits,
    });
    await persistence.append("one", {
      type: "update",
      goalId: "saved-goal",
      turnsUsed: 1,
      tokensUsed: 7,
      status,
    });
    await persistence.append("one", {
      type: "update",
      goalId: "older-goal",
      turnsUsed: 999,
      tokensUsed: 999,
    });
    const { client, requests, events } = fixture(() => output(), {
      goalPersistence: persistence,
    });
    await client.initializeSession("one");
    const goals = (await client.getSnapshot()).goals ?? [];
    if (status === "complete") {
      expect(goals).toEqual([]);
      expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
      expect(
        (await persistence.list("one")).some(
          (record) => record.status === "paused",
        ),
      ).toBe(false);
    } else {
      expect(goals[0]?.goal.status).toBe("paused");
      await command(client, ["status"]);
      const statusOutput = events.findLast(
        (event) =>
          event.type === "command.result.delivered" &&
          event.output?.kind === "text",
      );
      const statusText =
        statusOutput?.type === "command.result.delivered" &&
        statusOutput.output?.kind === "text"
          ? statusOutput.output.text
          : "";
      expect(statusText).toContain("1 turns");
      expect(statusText).toContain("7 total; usage incomplete");
      expect(statusText).toContain("turns remaining 3/4");
      expect(statusText).not.toContain("999");
      expect(statusText).not.toContain("tokens remaining");
      expect(statusText).not.toContain("Budget guidance");
    }
    expect(requests).toEqual([]);
  },
);

it("G22 records only admitted parent usage while a child and independent summary consume tokens", async () => {
  const { createBus } = await import("../bus/index.js");
  const { createMessageManager, createInMemoryMessageStore } =
    await import("../core/message/index.js");
  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  for (const role of ["user", "assistant", "user"] as const) {
    const message = await messageManager.createMessage({
      agent: "test",
      sessionId: "two",
      role,
    });
    await messageManager.appendPart(message.id, {
      type: "text",
      text: "independent summary context ".repeat(5000),
    });
  }
  const childStarted = deferred();
  const finishChild = deferred();
  let primarySteps = 0;
  let childSteps = 0;
  let summarySteps = 0;
  const { client, persistence } = fixture(
    async function* (request) {
      if (request.purpose === "context-summary") {
        summarySteps++;
        yield await Promise.resolve({
          textDelta: "<state_snapshot>independent summary</state_snapshot>",
          finishReason: "stop",
          tokenUsage: usage(1000, 900),
        });
        return;
      }
      if (JSON.stringify(request.messages).includes("Task: explore")) {
        childSteps++;
        childStarted.resolve();
        await finishChild.promise;
        yield {
          textDelta: "Child explored",
          finishReason: "stop",
          tokenUsage: usage(700, 600),
        };
        return;
      }
      primarySteps++;
      if (primarySteps === 1)
        yield {
          ...tool("subagent_run", {
            role: "explore",
            mode: "foreground",
            prompt: "Explore the isolated fixture",
            description: "usage isolation",
          }),
          tokenUsage: usage(10, 0),
        };
      else if (primarySteps === 2)
        yield {
          ...tool("UpdateGoal", { status: "complete" }),
          tokenUsage: usage(20, 3),
        };
      else
        yield {
          textDelta: "Parent finished",
          finishReason: "stop",
          tokenUsage: usage(30, 4),
        };
    },
    { bus, messageManager },
  );
  try {
    await command(client, ["delegate one isolated child then complete"]);
    await childStarted.promise;
    await expect(
      client.compactSession({ sessionId: "two" }),
    ).resolves.toMatchObject({ status: "compacted" });
    finishChild.resolve();
    await vi.waitFor(async () => {
      expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
    });
    expect(childSteps).toBe(1);
    expect(summarySteps).toBe(1);
    expect(primarySteps).toBe(3);
    expect(
      (await persistence.list("one"))
        .filter((record) => record.tokensUsed !== undefined)
        .at(-1),
    ).toMatchObject({
      tokensUsed: 60,
      cachedTokensUsed: 7,
      usageIncomplete: false,
    });
    expect(
      (await persistence.list("one"))
        .filter((record) => record.turnsUsed !== undefined)
        .map((record) => record.turnsUsed),
    ).toEqual([1]);
  } finally {
    finishChild.resolve();
  }
});

it.each(["pause-first", "admit-first"] as const)(
  "G7 serializes %s with a persisted-state append barrier",
  async (order) => {
    const { GoalService } = await import("../goals/index.js");
    const settlement = vi.spyOn(GoalService.prototype, "settleTurn");
    const persistence = new InMemoryGoalPersistence();
    const append = persistence.append.bind(persistence);
    const committing = deferred();
    const releaseCommit = deferred();
    const userStarted = deferred();
    const finishUser = deferred();
    let held = false;
    persistence.append = async (sessionId, record): Promise<void> => {
      if (
        !held &&
        (order === "admit-first"
          ? record.turnsUsed === 1
          : record.status === "paused")
      ) {
        held = true;
        committing.resolve();
        await releaseCommit.promise;
      }
      await append(sessionId, record);
    };
    const { client, requests } = fixture(
      async function* (_request, index) {
        if (order === "pause-first" && index === 0) {
          userStarted.resolve();
          await finishUser.promise;
        }
        yield { textDelta: "User finished", finishReason: "stop" };
      },
      { goalPersistence: persistence },
    );
    let originalUser:
      | Awaited<ReturnType<typeof client.submitPromptAccepted>>
      | undefined;
    let pause: Promise<unknown> | undefined;
    try {
      if (order === "pause-first") {
        originalUser = await client.submitPromptAccepted(
          "occupy while pause commits",
          { sessionId: "one" },
        );
        await userStarted.promise;
      }
      await command(client, ["serialize pause and admission"]);
      if (order === "pause-first") pause = command(client, ["pause"]);
      await committing.promise;
      if (order === "admit-first") pause = command(client, ["pause"]);
      else finishUser.resolve();
      releaseCommit.resolve();
      await pause;
      if (originalUser) await client.waitForPrompt(originalUser.promptId);
      const successor = await client.submitPromptAccepted(
        "verify lease was released",
        { sessionId: "one" },
      );
      await client.waitForPrompt(successor.promptId);
      const turns = (await persistence.list("one"))
        .filter((record) => record.turnsUsed !== undefined)
        .map((record) => record.turnsUsed);
      expect(turns).toEqual(order === "admit-first" ? [1] : []);
      expect(requests).toHaveLength(order === "admit-first" ? 1 : 2);
      if (order === "admit-first")
        expect(settlement.mock.calls[0]?.[2].status).toBe("cancelled");
      else expect(settlement).not.toHaveBeenCalled();
    } finally {
      releaseCommit.resolve();
      finishUser.resolve();
      await pause;
    }
  },
);

it.each(["goal", "user"] as const)(
  "G2 gives only %s the first execution through the shared owner barrier",
  async (first) => {
    const { GoalService } = await import("../goals/index.js");
    const ownerEntered = deferred();
    const releaseOwner = deferred();
    const providerStarted = deferred();
    const finishFirst = deferred();
    const prompts = new InMemoryPromptSubmissionStore();
    const claim = prompts.claim.bind(prompts);
    let held = false;
    prompts.claim = async (id): ReturnType<typeof claim> => {
      const record = await claim(id);
      if (first === "user" && !held) {
        held = true;
        ownerEntered.resolve();
        await releaseOwner.promise;
      }
      return record;
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The actual service receiver is supplied below.
    const admit = GoalService.prototype.admitTurnInBoundary;
    vi.spyOn(GoalService.prototype, "admitTurnInBoundary").mockImplementation(
      async function (
        this: import("../goals/index.js").GoalService,
        sessionId,
        goalId,
        epoch,
        available,
      ) {
        if (first === "goal" && available && !held) {
          held = true;
          ownerEntered.resolve();
          await releaseOwner.promise;
        }
        return admit.call(this, sessionId, goalId, epoch, available);
      },
    );
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        if (index === 0) {
          providerStarted.resolve();
          await finishFirst.promise;
        }
        if (
          (first === "goal" && index === 0) ||
          (first === "user" && index === 1)
        )
          yield tool("UpdateGoal", { status: "complete" });
        else yield { textDelta: "Done", finishReason: "stop" };
      },
      { promptSubmissionStore: prompts },
    );
    let creating: Promise<unknown> | undefined;
    let user:
      | Promise<Awaited<ReturnType<typeof client.submitPromptAccepted>>>
      | undefined;
    try {
      if (first === "goal")
        await command(client, ["goal wins owner admission"]);
      else
        user = client.submitPromptAccepted("user wins owner claim", {
          sessionId: "one",
        });
      await ownerEntered.promise;
      if (first === "goal")
        user = client.submitPromptAccepted("user waits for goal", {
          sessionId: "one",
        });
      else creating = command(client, ["goal waits for user"]);
      expect(requests).toHaveLength(0);
      releaseOwner.resolve();
      const accepted = await user;
      if (!accepted) throw new Error("Expected accepted user prompt");
      await creating;
      await providerStarted.promise;
      expect(requests).toHaveLength(1);
      const firstText = JSON.stringify(requests[0]?.messages.at(-1));
      expect(firstText).toContain(
        first === "goal"
          ? "goal wins owner admission"
          : "user wins owner claim",
      );
      if (first === "goal")
        expect((await prompts.get(accepted.promptId))?.status).toBe("queued");
      else
        expect(
          (await persistence.list("one")).filter(
            (record) => record.turnsUsed !== undefined,
          ),
        ).toEqual([]);
      finishFirst.resolve();
      await client.waitForPrompt(accepted.promptId);
      await vi.waitFor(async () => {
        expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
      });
      expect(
        (await persistence.list("one"))
          .filter((record) => record.turnsUsed !== undefined)
          .map((record) => record.turnsUsed),
      ).toEqual([1]);
      expect(requests).toHaveLength(3);
    } finally {
      releaseOwner.resolve();
      finishFirst.resolve();
      await creating;
      await user;
    }
  },
);

it("G8 shutdown exits a goal waiting behind user execution without starting a provider", async () => {
  const { GoalService } = await import("../goals/index.js");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below on the live service instance.
  const ensureDriving = GoalService.prototype.ensureDriving;
  const services: import("../goals/index.js").GoalService[] = [];
  vi.spyOn(GoalService.prototype, "ensureDriving").mockImplementation(function (
    this: import("../goals/index.js").GoalService,
    sessionId,
  ) {
    services.push(this);
    ensureDriving.call(this, sessionId);
  });
  const admission = vi.spyOn(GoalService.prototype, "admitTurnInBoundary");
  const userStarted = deferred();
  const { client, persistence, requests, prompts } = fixture(
    async function* (request) {
      userStarted.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else
          request.signal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
      });
      yield { textDelta: "Stopped", finishReason: "stop" };
    },
  );
  const user = await client.submitPromptAccepted(
    "user owns execution at shutdown",
    { sessionId: "one" },
  );
  await userStarted.promise;
  await command(client, ["goal should stay unadmitted at shutdown"]);
  await vi.waitFor(() => {
    expect(admission).toHaveBeenCalled();
  });
  const service = services.at(0);
  if (!service) throw new Error("Expected live goal service");
  const callsBeforeClose = admission.mock.calls.length;
  const idle = service.whenIdle("one");
  await expect(client.dispose()).resolves.toMatchObject({
    status: "confirmed",
  });
  await idle;
  expect(admission.mock.calls.length).toBeLessThanOrEqual(callsBeforeClose + 1);
  expect(requests).toHaveLength(1);
  expect(
    (await persistence.list("one")).filter(
      (record) => record.turnsUsed !== undefined,
    ),
  ).toEqual([]);
  expect((await prompts.get(user.promptId))?.status).toBe("interrupted");
});

it.each(["replace", "pause", "cancel"] as const)(
  "G24 preparation %s while runtime resolves its agent prevents the old worker from starting",
  async (action) => {
    const { AgentManager } = await import("../agents/index.js");
    const resolving = deferred();
    const releaseAgent = deferred();
    class PreparingAgentManager extends AgentManager {
      private first = true;
      override async getRuntimeAgent(
        ...args: Parameters<
          import("../agents/index.js").AgentManager["getRuntimeAgent"]
        >
      ): ReturnType<
        import("../agents/index.js").AgentManager["getRuntimeAgent"]
      > {
        if (this.first) {
          this.first = false;
          resolving.resolve();
          await releaseAgent.promise;
        }
        return super.getRuntimeAgent(...args);
      }
    }
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        yield await Promise.resolve(
          action === "replace" && index === 0
            ? tool("UpdateGoal", { status: "complete" })
            : { textDelta: "Finished", finishReason: "stop" },
        );
      },
      { agentManager: new PreparingAgentManager() },
    );
    let mutation: Promise<unknown> | undefined;
    try {
      await command(client, ["old preparation objective"]);
      await resolving.promise;
      mutation = command(
        client,
        action === "replace"
          ? ["replace", "new preparation objective"]
          : [action],
      );
      await vi.waitFor(async () => {
        const records = await persistence.list("one");
        if (action === "replace")
          expect(records.at(-1)?.objective).toBe("new preparation objective");
        else if (action === "pause")
          expect(records.at(-1)?.status).toBe("paused");
        else expect(records.at(-1)?.type).toBe("clear");
      });
      expect(requests).toHaveLength(0);
      releaseAgent.resolve();
      await mutation;
      if (action === "replace") {
        await vi.waitFor(async () => {
          expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
        });
        expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain(
          "new preparation objective",
        );
        expect(requests).toHaveLength(2);
      } else {
        const user = await client.submitPromptAccepted(
          "successor user after preparation stop",
          { sessionId: "one" },
        );
        await client.waitForPrompt(user.promptId);
        expect(requests).toHaveLength(1);
        expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain(
          "successor user after preparation stop",
        );
        expect(requests[0]?.signal?.aborted).toBe(false);
      }
      expect(
        (await persistence.list("one"))
          .filter((record) => record.turnsUsed !== undefined)
          .map((record) => record.turnsUsed),
      ).toEqual(action === "replace" ? [1, 2] : [1]);
    } finally {
      releaseAgent.resolve();
      await mutation;
    }
  },
);

it.each(["claim", "running"] as const)(
  "G24 cancels preparation during ledger %s and closes the old pending run",
  async (stage) => {
    const { createInMemoryRunLedger } =
      await import("../runtime/run-ledger/index.js");
    const ledger = createInMemoryRunLedger();
    const saving = deferred();
    const release = deferred();
    let ids = 0;
    const ledgerModule = await import("./ui-state/coordinated-run-ledger.js");
    const createCoordinated = ledgerModule.createCoordinatedRunLedger;
    vi.spyOn(ledgerModule, "createCoordinatedRunLedger").mockImplementation(
      (options) => {
        const coordinated = createCoordinated(options);
        const claim = coordinated.claimPendingRun.bind(coordinated);
        const running = coordinated.markRunning.bind(coordinated);
        coordinated.claimPendingRun = async (
          input,
        ): ReturnType<typeof claim> => {
          const record = await claim(input);
          if (stage === "claim" && input.runId === "preparing-old") {
            saving.resolve();
            await release.promise;
          }
          return record;
        };
        coordinated.markRunning = async (runId): ReturnType<typeof running> => {
          const record = await running(runId);
          if (stage === "running" && runId === "preparing-old") {
            saving.resolve();
            await release.promise;
          }
          return record;
        };
        return coordinated;
      },
    );
    const { client, persistence, requests } = fixture(
      async function* (_request, index) {
        yield await Promise.resolve(
          index === 0
            ? tool("UpdateGoal", { status: "complete" })
            : { textDelta: "New objective finished", finishReason: "stop" },
        );
      },
      {
        runLedger: ledger,
        createRunId: () =>
          ++ids === 1 ? "preparing-old" : `new-${String(ids)}`,
      },
    );
    try {
      await command(client, ["old ledger preparation objective"]);
      await saving.promise;
      await command(client, ["replace", "new ledger preparation objective"]);
      expect(requests).toHaveLength(0);
      release.resolve();
      await vi.waitFor(async () => {
        expect((await persistence.list("one")).at(-1)?.type).toBe("clear");
      });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain(
        "new ledger preparation objective",
      );
      const oldRun = await ledger.get("preparing-old");
      expect(oldRun).toMatchObject({
        status: "interrupted",
        inputsCloseReason: "run preparation cancelled",
      });
      expect(typeof oldRun?.inputsClosedAt).toBe("number");
      expect(
        (await persistence.list("one"))
          .filter((record) => record.turnsUsed !== undefined)
          .map((record) => record.turnsUsed),
      ).toEqual([1, 2]);
    } finally {
      release.resolve();
    }
  },
);
