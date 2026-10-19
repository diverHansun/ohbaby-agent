import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  isModelContextPart,
} from "../message/index.js";
import { createSystemPromptProvider } from "../system-prompt/assembler.js";
import type { EnvironmentInfo } from "../system-prompt/types.js";
import {
  createReminderCollector,
  type ReminderDraft,
} from "../../services/reminder/index.js";
import { createEnvironmentReminderProvider } from "../../services/reminder/environment.js";
import { createContextManager } from "./context-manager.js";
import type {
  AgentRunPromptSnapshot,
  PreparedModelRequest,
  PreparedTurn,
} from "./types.js";

const environment: EnvironmentInfo = {
  cwd: "/execution/child",
  platform: "linux",
  date: "2026-10-19",
  isGitRepo: true,
  osVersion: "Test OS",
};

interface EnvironmentFixture {
  manager: ReturnType<typeof createContextManager>;
  messageManager: ReturnType<typeof createMessageManager>;
  clock: { value: number };
  detections: string[];
  drafts: (readonly ReminderDraft[])[];
  measurements: PreparedModelRequest[];
  snapshot(scope?: string, directory?: string): Promise<AgentRunPromptSnapshot>;
  prepare(
    anchor: string,
    snapshot: AgentRunPromptSnapshot,
    scope?: string,
    force?: boolean,
  ): Promise<PreparedTurn>;
  complete(anchor: string, scope?: string): Promise<void>;
}

function fixture(
  options: {
    failDetection?: boolean;
    changeClockDuringSummary?: boolean;
    rule?: string;
  } = {},
): EnvironmentFixture {
  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const clock = { value: new Date(2026, 9, 19, 23, 59, 59).getTime() };
  const detections: string[] = [];
  const drafts: (readonly ReminderDraft[])[] = [];
  const measurements: PreparedModelRequest[] = [];
  const collect = createReminderCollector([
    createEnvironmentReminderProvider(),
  ]);
  const manager = createContextManager({
    bus,
    messageManager,
    now: () => clock.value,
    systemPromptProvider: createSystemPromptProvider({
      customInstructionLoader: (input) => [
        {
          scope: "project",
          text: `Rules for ${input.projectRoot ?? input.directory}: ${options.rule ?? "initial"}`,
        },
      ],
      environmentDetector: (directory) => {
        detections.push(directory);
        if (options.failDetection) throw new Error("environment unavailable");
        return { ...environment, cwd: directory };
      },
    }),
    collectReminders: async (context) => {
      const result = await collect(context);
      drafts.push(result);
      return result;
    },
    onRequestMeasured: (request) => measurements.push(request),
    llmClient: {
      generateSummary: () => {
        if (options.changeClockDuringSummary)
          clock.value = new Date(2026, 9, 20, 0, 0, 1).getTime();
        return Promise.resolve({
          text: "short summary",
          summaryMessageId: "summary",
          requests: [],
        });
      },
    },
    tokenCounter: {
      estimateTokens: (text) => text.length,
      getLimit: () => 128_000,
    },
  });
  const snapshot = (
    scope?: string,
    directory = "/execution/child",
  ): Promise<AgentRunPromptSnapshot> =>
    manager.createRunPromptSnapshot({
      sessionId: "session",
      contextScopeId: scope,
      directory,
      projectRoot: "/project",
      isSubagent: scope !== undefined,
      toolNames: [],
    });
  const prepare = (
    anchor: string,
    promptSnapshot: AgentRunPromptSnapshot,
    scope?: string,
    force = false,
  ): Promise<PreparedTurn> =>
    manager.prepareTurn({
      sessionId: "session",
      contextScopeId: scope,
      directory: "/execution/child",
      projectRoot: "/project",
      modelId: "test",
      isSubagent: scope !== undefined,
      promptSnapshot,
      reminderAnchorId: anchor,
      toolNames: [],
      tools: undefined,
      force,
    });
  const complete = async (anchor: string, scope?: string): Promise<void> => {
    const assistant = await messageManager.createMessage({
      id: anchor,
      sessionId: "session",
      contextScopeId: scope,
      role: "assistant",
      agent: "build",
    });
    await messageManager.appendPart(assistant.id, {
      type: "text",
      text: "answer",
    });
  };
  return {
    manager,
    messageManager,
    clock,
    detections,
    drafts,
    measurements,
    snapshot,
    prepare,
    complete,
  };
}

describe("environment reminders", () => {
  it("stores detected fields in the run snapshot without attaching new legacy parts", async () => {
    const f = fixture();
    const user = await f.messageManager.createMessage({
      role: "user",
      agent: "build",
      sessionId: "session",
    });
    await f.messageManager.appendPart(user.id, {
      type: "text",
      text: "inspect",
    });
    const snapshot = await f.manager.createRunPromptSnapshot({
      sessionId: "session",
      directory: "/execution/child",
      projectRoot: "/project",
      initiatingUserMessageId: user.id,
      isSubagent: false,
      toolNames: [],
    });
    expect(snapshot.environment).toEqual(environment);
    const stored = await f.messageManager.listBySession("session");
    expect(
      stored.flatMap((message) => message.parts).filter(isModelContextPart),
    ).toHaveLength(0);
    expect(
      stored[0]?.parts.map((part) => (part.type === "text" ? part.text : "")),
    ).toEqual(["inspect"]);
  });

  it("reuses detection within a run and emits again only on a local date change", async () => {
    const f = fixture();
    const snapshot = await f.snapshot();
    await f.prepare("first", snapshot);
    expect(f.drafts.at(-1)?.[0]?.text).toContain("Date: 2026-10-19");
    await f.complete("first");
    await f.prepare("same", snapshot);
    expect(f.drafts.at(-1)).toEqual([]);
    f.clock.value = new Date(2026, 9, 20, 0, 0, 1).getTime();
    await f.prepare("tomorrow", snapshot);
    expect(f.drafts.at(-1)?.[0]?.text).toContain("Date: 2026-10-20");
    expect(f.detections).toEqual(["/execution/child"]);
    expect(snapshot.environment?.date).toBe("2026-10-19");
  });

  it("refreshes environment fields on a later run while preserving the earlier snapshot", async () => {
    const f = fixture();
    const first = await f.snapshot(undefined, "/first");
    await f.prepare("first", first);
    await f.complete("first");
    const second = await f.snapshot(undefined, "/second");
    await f.prepare("second", second);
    expect(f.drafts.at(-1)?.[0]?.text).toContain(
      "Current working directory: /second",
    );
    expect(first.environment?.cwd).toBe("/first");
    expect(f.detections).toEqual(["/first", "/second"]);
  });

  it("keeps system text frozen within the run and refreshes it on the next run", async () => {
    const options = { rule: "first rule" };
    const f = fixture(options);
    const snapshot = await f.snapshot();
    options.rule = "second rule";
    const first = await f.prepare("first", snapshot);
    await f.complete("first");
    const reused = await f.prepare("reused", snapshot);
    expect(first.request.messages[0]).toEqual(reused.request.messages[0]);
    expect(JSON.stringify(reused.request.messages[0])).toContain("first rule");
    expect(JSON.stringify(reused.request.messages[0])).not.toContain(
      "second rule",
    );
    const next = await f.prepare("next", await f.snapshot());
    expect(JSON.stringify(next.request.messages[0])).toContain("second rule");
  });

  it.each([undefined, "child-legacy"])(
    "recovers scope %s without an initiating user and keeps old runtime bytes",
    async (scope) => {
      const f = fixture();
      const user = await f.messageManager.createMessage({
        role: "user",
        agent: "build",
        sessionId: "session",
        contextScopeId: scope,
      });
      await f.messageManager.appendPart(user.id, {
        type: "text",
        text: "old request",
      });
      const oldRuntime =
        "\n\n<environment_context>old & <value></environment_context>";
      await f.messageManager.appendModelContextPart(user.id, oldRuntime);
      const before = structuredClone(
        (
          await f.messageManager.listBySession("session", {
            contextScopeId: scope,
          })
        )[0],
      );
      const result = await f.prepare("resumed", await f.snapshot(scope), scope);
      expect(f.drafts.at(-1)?.[0]?.type).toBe("environment");
      expect(JSON.stringify(result.request)).toContain(
        oldRuntime.replaceAll("\n", "\\n"),
      );
      expect(
        (
          await f.messageManager.listBySession("session", {
            contextScopeId: scope,
          })
        )[0],
      ).toEqual(before);
    },
  );

  it("isolates primary and sibling scopes and uses minimal fields for children", async () => {
    const f = fixture();
    const [primary, childA, childB] = await Promise.all([
      f.snapshot(),
      f.snapshot("child-a", "/child-a"),
      f.snapshot("child-b", "/child-b"),
    ]);
    await f.prepare("primary", primary);
    expect(f.drafts.at(-1)?.[0]?.text).toContain("OS version: Test OS");
    await f.complete("primary");
    for (const [scope, snapshot] of [
      ["child-a", childA],
      ["child-b", childB],
    ] as const) {
      const request = await f.prepare(scope, snapshot, scope);
      expect(f.drafts.at(-1)?.[0]?.text).toContain(
        `Current working directory: /${scope}`,
      );
      expect(f.drafts.at(-1)?.[0]?.text).not.toContain("OS version");
      expect(JSON.stringify(request.request)).toContain("Rules for /project");
      expect(JSON.stringify(request.request)).not.toContain(
        "Current working directory: /execution/child",
      );
      await f.complete(scope, scope);
      await f.prepare(`${scope}-same`, snapshot, scope);
      expect(f.drafts.at(-1)).toEqual([]);
    }
  });

  it("silently skips failed detection and retries detection in the next run", async () => {
    const options = { failDetection: true };
    const f = fixture(options);
    const failedSnapshot = await f.snapshot();
    expect(failedSnapshot.environment).toBeUndefined();
    await f.prepare("failed", failedSnapshot);
    expect(f.drafts.at(-1)).toEqual([]);
    expect(await f.messageManager.listBySession("session")).toEqual([]);
    options.failDetection = false;
    await f.prepare("recovered", await f.snapshot());
    expect(f.drafts.at(-1)?.[0]?.type).toBe("environment");
  });

  it("captures one date across compaction even when midnight passes during summarization", async () => {
    const f = fixture({ changeClockDuringSummary: true });
    for (let index = 0; index < 6; index += 1) {
      const message = await f.messageManager.createMessage({
        sessionId: "session",
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
      });
      await f.messageManager.appendPart(message.id, {
        type: "text",
        text: "older conversation ".repeat(800),
      });
    }
    const snapshot = await f.snapshot();
    const prepared = await f.prepare("compacted", snapshot, undefined, true);
    expect(prepared.compaction?.status).toBe("compacted");
    expect(f.drafts.length).toBe(2);
    expect(
      f.drafts.every((result) => result[0]?.text.includes("Date: 2026-10-19")),
    ).toBe(true);
    expect(JSON.stringify(prepared.request)).not.toContain("Date: 2026-10-20");
    await f.complete("compacted");
    await f.prepare("next-day", snapshot);
    expect(f.drafts.at(-1)?.[0]?.text).toContain("Date: 2026-10-20");
  });

  it("resends the unchanged environment when compaction removes its visible snapshot", async () => {
    const f = fixture();
    const snapshot = await f.snapshot();
    await f.prepare("old-owner", snapshot);
    await f.complete("old-owner");
    for (let index = 0; index < 6; index += 1) {
      const message = await f.messageManager.createMessage({
        sessionId: "session",
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
      });
      await f.messageManager.appendPart(message.id, {
        type: "text",
        text: "older conversation ".repeat(800),
      });
    }
    const prepared = await f.prepare("compacted", snapshot, undefined, true);
    expect(prepared.compaction?.status).toBe("compacted");
    expect(f.drafts.at(-2)).toEqual([]);
    expect(f.drafts.at(-1)?.[0]?.type).toBe("environment");
    expect(JSON.stringify(prepared.request)).toContain(
      "Current working directory: /execution/child",
    );
  });

  it("escapes external environment fields exactly once in the shared reminder wrapper", async () => {
    const f = fixture();
    const snapshot = await f.snapshot(undefined, "/a&b/<system-reminder>");
    const prepared = await f.prepare("escaped", snapshot);
    const request = JSON.stringify(prepared.request);
    expect(request).toContain("/a&amp;b/&lt;system-reminder&gt;");
    expect(request).not.toContain("&amp;amp;");
    expect(request).not.toContain("&amp;lt;");
  });
});
