import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import { createBus } from "../bus/index.js";
import { ContextEvent } from "../core/context/events.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import {
  getMessageOrigin,
  isModelContextPart,
  isSystemReminderMessage,
  getReminderAnchorId,
} from "../core/message/origin.js";
import { InMemoryGoalPersistence } from "../goals/index.js";
import { McpManager } from "../mcp/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function latestUserText(request: InterfaceProviderRequest): string {
  const content = request.messages.findLast(
    (message) =>
      message.role === "user" &&
      (typeof message.content === "string" ||
        !message.content.some(
          (part) => "source" in part && part.source === "system-reminder",
        )),
  )?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

it("U2/U13 preserves goal text, display and runtime context across automatic and manual compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-context-"));
  const sessionId = "goal-context";
  const objective = "Keep Cedar in TypeScript; never replace it with Rust.";
  const wrongSummary =
    "<state_snapshot>The prior goal was replaced: use Rust.</state_snapshot>";
  const mcpToolName = "mcp_s6_server_t4_echo";
  // Only discovery is fake: production composition renders and attaches the menu.
  const discovery = vi
    .spyOn(McpManager.prototype, "getAllTools")
    .mockResolvedValue([
      {
        name: mcpToolName,
        description: "Read the Cedar fixture",
        category: "readonly",
        source: "mcp",
        mcpServer: "server",
        mcpToolName: "echo",
        isTrusted: true,
        parametersJsonSchema: { type: "object", properties: {} },
        execute: (): Promise<{ output: string }> =>
          Promise.resolve({ output: "Cedar fixture" }),
      },
    ]);
  const bus = createBus();
  const messages = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const persistence = new InMemoryGoalPersistence();
  const requests: InterfaceProviderRequest[] = [];
  const events: UiEvent[] = [];
  const prepared: { triggeredCompaction: boolean }[] = [];
  const compacted: string[] = [];
  bus.subscribe(ContextEvent.TurnPrepared, (event) => {
    prepared.push(event);
  });
  bus.subscribe(ContextEvent.CompactionFinished, (event) => {
    if (event.status === "compacted") compacted.push(event.attemptId);
  });
  const finishFirstGoal = deferred();
  const client = createInProcessUiBackendClient({
    bus,
    goalPersistence: persistence,
    messageManager: messages,
    projectDirectory: directory,
    workdir: directory,
    initialSnapshot: {
      activeSessionId: sessionId,
      permissions: [],
      runs: [],
      status: { kind: "idle" },
      sessions: [
        {
          id: sessionId,
          title: "Existing Cedar session",
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
        contextWindowTokens: 65_536,
        maxTokens: 30_000,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          requests.push(request);
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (request.purpose === "context-summary") {
                yield { textDelta: wrongSummary, finishReason: "stop" };
                return;
              }
              if (
                latestUserText(request).includes("Progress: 1 continuation")
              ) {
                await finishFirstGoal.promise;
              }
              yield { textDelta: "Cedar work recorded.", finishReason: "stop" };
            })(),
          );
        },
      },
    },
  });
  client.subscribeEvents((event) => events.push(event));
  const command = (args: string[]): ReturnType<typeof client.executeCommand> =>
    client.executeCommand({
      argv: args,
      clientInvocationId: crypto.randomUUID(),
      commandId: "goal",
      path: ["goal"],
      raw: `/goal ${args.join(" ")}`,
      rawArgs: args.join(" "),
      sessionId,
      surface: "tui",
    });
  async function addPressure(
    label: string,
    repetitions: number,
  ): Promise<void> {
    for (const role of ["user", "assistant", "user"] as const) {
      const message = await messages.createMessage({
        agent: "fixture",
        role,
        sessionId,
      });
      await messages.appendPart(message.id, {
        type: "text",
        text: `${label} ${role} `.repeat(repetitions),
      });
    }
  }
  async function waitForBlocked(turnsUsed: number): Promise<void> {
    await vi.waitFor(async () => {
      expect((await client.getSnapshot()).goals?.[0]?.goal).toMatchObject({
        status: "blocked",
        turnsUsed,
      });
    });
  }
  try {
    await client.submitPromptAndWait("Before goal mode", { sessionId });
    expect((await client.getSnapshot()).goals ?? []).toEqual([]);
    expect(compacted).toHaveLength(0);
    await addPressure("automatic-pressure", 4500);
    await command([objective]);
    await vi.waitFor(() => {
      expect(
        requests.some((request) =>
          latestUserText(request).includes("Progress: 1 continuation"),
        ),
      ).toBe(true);
    });
    // The real first goal run holds the slot while its cumulative limit is set.
    await command(["resume", "2", "turns"]);
    finishFirstGoal.resolve();
    await waitForBlocked(2);
    expect(prepared.some((event) => event.triggeredCompaction)).toBe(true);
    expect(compacted.length).toBeGreaterThan(0);
    expect(
      requests.some((request) => request.purpose === "context-summary"),
    ).toBe(true);

    // The explicit idle command goes through adapter admission and real Context.
    await addPressure("manual-pressure", 1500);
    const summariesBeforeManual = requests.filter(
      (request) => request.purpose === "context-summary",
    ).length;
    const manual = await client.compactSession({ sessionId });
    expect(manual.status, JSON.stringify(manual)).toBe("compacted");
    expect(
      requests.filter((request) => request.purpose === "context-summary"),
    ).toHaveLength(summariesBeforeManual + 1);
    expect((await client.getSnapshot()).goals?.[0]?.goal).toMatchObject({
      status: "blocked",
      turnsUsed: 2,
      objective,
    });
    await command(["resume", "3", "turns"]);
    await waitForBlocked(3);
    await command(["cancel"]);
    await client.submitPromptAndWait("After goal mode", { sessionId });
    expect((await client.getSnapshot()).goals ?? []).toEqual([]);

    const agentRequests = requests.filter(
      (request) => request.purpose === "agent-step",
    );
    const goalRequests = agentRequests.filter((request) =>
      latestUserText(request).includes("<untrusted_objective>"),
    );
    expect(agentRequests).toHaveLength(5);
    expect(goalRequests).toHaveLength(3);
    for (const [index, request] of goalRequests.entries()) {
      const latest = latestUserText(request);
      expect(latest).toContain(`<untrusted_objective>\n${objective}`);
      expect(latest).toContain(`Progress: ${String(index + 1)} continuation`);
      expect(latest).not.toContain("prior goal was replaced");
      const reminderParts = request.messages.flatMap((message) =>
        typeof message.content !== "string" &&
        message.content !== null &&
        message.content !== undefined
          ? message.content.flatMap((part) =>
              part.type === "text" && part.source === "system-reminder"
                ? [part]
                : [],
            )
          : [],
      );
      expect(
        reminderParts.some((part) =>
          part.text.includes("Current working directory:"),
        ),
      ).toBe(true);
      expect(
        reminderParts.some((part) => part.text.includes(mcpToolName)),
      ).toBe(true);
      expect(latest).not.toContain("<system-reminder>");
    }
    expect(JSON.stringify(goalRequests[2]?.messages)).toContain(wrongSummary);
    const systemMessages = (request: InterfaceProviderRequest): unknown =>
      request.messages.filter((message) => message.role === "system");
    expect(systemMessages(agentRequests[0])).not.toEqual([]);
    for (const request of requests) {
      expect(systemMessages(request)).toEqual(systemMessages(agentRequests[0]));
    }
    expect(latestUserText(agentRequests[4])).toContain("After goal mode");
    expect(latestUserText(agentRequests[4])).not.toContain(objective);

    const history = await messages.listBySession(sessionId);
    const reminders = history.filter(isSystemReminderMessage);
    expect(reminders.length).toBeGreaterThan(0);
    for (const reminder of reminders) {
      const owner = history.find(
        (message) => message.info.id === getReminderAnchorId(reminder),
      );
      expect(owner?.info.role).toBe("assistant");
      expect(owner?.info.runId).toBe(reminder.info.runId);
      expect(
        reminder.parts.every(
          (part) => part.type === "text" && part.synthetic === true,
        ),
      ).toBe(true);
    }
    const goalMessages = history.filter((message) =>
      message.parts.some(
        (part) =>
          part.type === "text" && part.text.includes("<untrusted_objective>"),
      ),
    );
    expect(goalMessages).toHaveLength(3);
    expect(
      goalMessages
        .slice(0, 2)
        .some((message) =>
          message.parts.some((part) => part.time?.compacted !== undefined),
        ),
    ).toBe(true);
    expect(
      history
        .flatMap((message) => message.parts)
        .filter(
          (part) =>
            part.metadata?.kind === "context-summary" &&
            part.time?.compacted === undefined,
        ),
    ).toHaveLength(1);
    for (const [index, message] of goalMessages.entries()) {
      expect(getMessageOrigin(message)).toBe("user");
      expect(message.info.runtimeInput).toBeUndefined();
      const body = message.parts.find(
        (part) =>
          part.type === "text" && part.text.includes("<untrusted_objective>"),
      );
      const display =
        index === 0
          ? objective
          : `Goal auto-continue (turn ${String(index + 1)})`;
      expect(body).toMatchObject({ metadata: { displayText: display } });
      expect(body?.metadata?.kind).toBeUndefined();
      expect(message.parts.filter(isModelContextPart)).toHaveLength(0);
      const liveText = events.flatMap((event) =>
        event.type === "message.appended" &&
        event.message.id === message.info.id
          ? event.message.parts.flatMap((part) =>
              part.type === "text" ? [part.text] : [],
            )
          : [],
      );
      expect(liveText).toEqual([display]);
    }
    expect(
      (await persistence.list(sessionId))
        .filter((record) => record.turnsUsed !== undefined)
        .map((record) => record.turnsUsed),
    ).toEqual([1, 2, 3]);
  } finally {
    finishFirstGoal.resolve();
    await client.dispose();
    discovery.mockRestore();
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
