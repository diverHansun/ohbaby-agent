import { describe, expect, it } from "vitest";
import type { MessageWithParts, ToolPart } from "../../core/message/index.js";
import { isActivePart } from "../../core/context/filters.js";
import { arrangeReminderHistory } from "../../core/context/reminder-history.js";
import { serializeHistoryMessages } from "../../core/context/serializer.js";
import {
  TodoWorkScopeRegistry,
  type TodoItem,
  type TodoWorkScopeId,
} from "../../tools/todo.js";
import { createTodoReminderProvider } from "./todo.js";
import {
  createReminderCollector,
  renderReminderText,
  type ReminderDraft,
} from "./index.js";

const todos: readonly TodoItem[] = [
  { content: "Review <results> & report", status: "pending" },
  { content: "Implement reminder", status: "in_progress" },
  { content: "Finished setup", status: "completed" },
];

function assistant(id: string, scope?: string): MessageWithParts {
  return {
    info: {
      id,
      sessionId: "s",
      contextScopeId: scope,
      role: "assistant",
      agent: "build",
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: `${id}-text`,
        messageId: id,
        sessionId: "s",
        orderIndex: 0,
        type: "text",
        text: "answer",
      },
    ],
  };
}

function replies(
  count: number,
  prefix = "reply",
  scope?: string,
): MessageWithParts[] {
  return Array.from({ length: count }, (_, i) =>
    assistant(`${prefix}-${String(i)}`, scope),
  );
}

function todoTool(
  id: string,
  options: {
    todos?: readonly TodoItem[];
    workScopeId?: TodoWorkScopeId;
    contextScopeId?: string;
    tool?: "todo_read" | "todo_write";
    status?: "completed" | "error" | "pending" | "running";
    output?: string;
  } = {},
): MessageWithParts {
  const list = options.todos ?? todos;
  const status = options.status ?? "completed";
  const input = { todos: list };
  const metadata = {
    todos: list,
    count: list.length,
    ...(options.workScopeId
      ? { internalWorkScopeId: options.workScopeId }
      : {}),
  };
  const state: ToolPart["state"] =
    status === "completed"
      ? {
          status,
          input,
          metadata,
          output:
            options.output ??
            list.map((t) => `[${t.status}] ${t.content}`).join("\n"),
        }
      : status === "error"
        ? { status, input, error: "failed" }
        : status === "pending"
          ? { status, input, raw: "{}" }
          : { status, input };
  const message = assistant(id, options.contextScopeId);
  return {
    ...message,
    parts: [
      {
        id: `${id}-tool`,
        messageId: id,
        sessionId: "s",
        orderIndex: 0,
        type: "tool",
        tool: options.tool ?? "todo_write",
        callId: id,
        state,
      },
    ],
  };
}

function saved(
  draft: ReminderDraft,
  anchor: string,
  scope?: string,
): MessageWithParts {
  const message = assistant(`reminder-${anchor}`, scope);
  return {
    info: { ...message.info, role: "user", agent: "build" },
    parts: [
      {
        id: `${anchor}-reminder`,
        messageId: message.info.id,
        sessionId: "s",
        orderIndex: 0,
        type: "text",
        text: renderReminderText(draft.text),
        synthetic: true,
        metadata: {
          kind: "system-reminder:v1",
          reminderType: "todo",
          key: draft.key,
          anchorAssistantId: anchor,
        },
      },
    ],
  };
}

function summary(id = "compaction"): MessageWithParts {
  const message = assistant(`summary-${id}`);
  return {
    ...message,
    parts: [
      {
        id,
        messageId: message.info.id,
        sessionId: "s",
        orderIndex: 0,
        type: "text",
        synthetic: true,
        text: "Summary without list",
        metadata: { kind: "context-summary", compactionId: id },
      },
    ],
  };
}

function retire(message: MessageWithParts): MessageWithParts {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part, time: { compacted: 3 } })),
  };
}

function setup(): {
  readonly scopes: TodoWorkScopeRegistry;
  readonly collect: (
    history: readonly MessageWithParts[],
    contextScopeId?: string,
  ) => Promise<readonly ReminderDraft[]>;
} {
  const scopes = new TodoWorkScopeRegistry();
  const collector = createReminderCollector([
    createTodoReminderProvider(scopes),
  ]);
  const collect = (
    fullHistory: readonly MessageWithParts[],
    contextScopeId?: string,
  ): Promise<readonly ReminderDraft[]> => {
    const active = fullHistory.flatMap((message) => {
      const parts = message.parts.filter(isActivePart);
      return parts.length === 0 ? [] : [{ ...message, parts }];
    });
    const history = arrangeReminderHistory(active).filter(
      (message) => serializeHistoryMessages([message]).length > 0,
    );
    return collector({
      sessionId: "s",
      contextScopeId,
      isSubagent: contextScopeId !== undefined,
      history,
      fullHistory,
      protectedInputs: [],
    });
  };
  return { collect, scopes };
}

describe("Todo reminders", () => {
  it("waits for 10 assistants after the successful write and keeps unfinished status and priority", async () => {
    const { collect } = setup();
    const write = todoTool("write");
    expect(await collect([write, ...replies(9)])).toEqual([]);
    const [draft] = await collect([write, ...replies(10)]);
    expect(draft.text).toContain(
      "[in_progress] Implement reminder\n[pending] Review <results> & report",
    );
    expect(draft.text).not.toContain("Finished setup");
    expect(draft.text).toContain("todo_read");
    expect(renderReminderText(draft.text)).toContain(
      "Review &lt;results&gt; &amp; report",
    );
  });

  it("counts the reminder anchor as the first response and periodically reissues an unchanged list", async () => {
    const { collect } = setup();
    const original = [todoTool("write"), ...replies(10)];
    const [first] = await collect(original);
    expect((await collect([...original, assistant("extra")]))[0]?.key).toBe(
      first.key,
    );
    const history = [...original, saved(first, "anchor"), assistant("anchor")];
    expect(await collect([...history, ...replies(8, "later")])).toEqual([]);
    const [second] = await collect([...history, ...replies(9, "later")]);
    expect(second.text).toBe(first.text);
    expect(second.key).not.toBe(first.key);
    const next = [
      ...history,
      ...replies(9, "later"),
      saved(second, "second"),
      assistant("second"),
    ];
    expect(await collect([...next, ...replies(8, "third")])).toEqual([]);
    expect(await collect([...next, ...replies(9, "third")])).toHaveLength(1);
  });

  it("ignores a Todo reminder whose body is ignored by model projection", async () => {
    const { collect } = setup();
    const history = [todoTool("write"), ...replies(10)];
    const [draft] = await collect(history);
    const ignored = saved(draft, "ignored");
    expect(
      await collect([
        ...history,
        {
          ...ignored,
          parts: ignored.parts.map((part) => ({ ...part, ignored: true })),
        },
        assistant("ignored"),
      ]),
    ).toHaveLength(1);
  });

  it("resets the write baseline for a completed write even when the list is unchanged", async () => {
    const { collect } = setup();
    const old = [todoTool("old"), ...replies(10)];
    const [first] = await collect(old);
    const history = [
      ...old,
      saved(first, "anchor"),
      assistant("anchor"),
      todoTool("unchanged"),
    ];
    expect(await collect([...history, ...replies(9, "after-write")])).toEqual(
      [],
    );
    expect(
      await collect([...history, ...replies(10, "after-write")]),
    ).toHaveLength(1);
  });

  it("does not treat failed, pending or running writes as a successful baseline", async () => {
    for (const status of ["error", "pending", "running"] as const) {
      const { collect } = setup();
      expect(
        await collect([
          todoTool("write"),
          ...replies(9),
          todoTool("failed", { status }),
        ]),
      ).toHaveLength(1);
    }
  });

  it("counts visible failed text once, ignores hidden failures, summaries, empty anchors and duplicate assistant IDs", async () => {
    const { collect } = setup();
    const visible = assistant("visible");
    const visibleFailure: MessageWithParts = {
      ...visible,
      info: {
        ...visible.info,
        role: "assistant",
        agent: "build",
        finish: "error",
        error: { name: "MessageOutputLengthError" },
      },
      parts: [...visible.parts, ...visible.parts],
    };
    const hidden = assistant("hidden");
    const hiddenFailure: MessageWithParts = {
      ...hidden,
      info: {
        ...hidden.info,
        role: "assistant",
        agent: "build",
        finish: "error",
        error: { name: "APIError", message: "failed", isRetryable: false },
      },
    };
    const empty = { ...assistant("empty"), parts: [] };
    const history = [
      todoTool("write"),
      ...replies(8),
      hiddenFailure,
      summary(),
      empty,
    ];
    expect(await collect([...history, visibleFailure, visibleFailure])).toEqual(
      [],
    );
    expect(
      await collect([...history, visibleFailure, assistant("tenth")]),
    ).toHaveLength(1);
  });

  it("counts parallel tool calls as one assistant", async () => {
    const { collect } = setup();
    const parallel = todoTool("parallel", { tool: "todo_read" });
    const history = [
      todoTool("write"),
      ...replies(8),
      { ...parallel, parts: [...parallel.parts, ...parallel.parts] },
    ];
    expect(await collect(history)).toEqual([]);
    expect(await collect([...history, assistant("tenth")])).toHaveLength(1);
  });

  it("starts an absent write baseline at the effective history beginning without counting the summary", async () => {
    const { collect } = setup();
    const retired = retire(todoTool("old-write"));
    const read = todoTool("read", { tool: "todo_read" });
    expect(await collect([retired, summary(), read, ...replies(8)])).toEqual(
      [],
    );
    expect(
      await collect([retired, summary(), read, ...replies(9)]),
    ).toHaveLength(1);
  });

  it("does not remind for absent, empty or completed lists", async () => {
    const { collect } = setup();
    expect(await collect(replies(20))).toEqual([]);
    for (const list of [
      [],
      [{ content: "Done", status: "completed" as const }],
    ]) {
      expect(
        await collect([
          retire(todoTool("write", { todos: list })),
          summary(),
          ...replies(20),
        ]),
      ).toEqual([]);
    }
  });

  it("immediately recovers the missing list after committed compaction and deduplicates its visible replacement", async () => {
    const { collect } = setup();
    const history = [retire(todoTool("write")), summary()];
    const [draft] = await collect(history);
    expect(draft.text).toContain("Implement reminder");
    expect(
      await collect([...history, saved(draft, "owner"), assistant("owner")]),
    ).toEqual([]);
    expect(
      await collect([
        history[0],
        summary(),
        saved(draft, "abandoned"),
        { ...assistant("abandoned"), parts: [] },
      ]),
    ).toHaveLength(1);
    expect(await collect([retire(todoTool("write"))])).toEqual([]);
  });

  it("uses the final visible list body rather than retained tool metadata or compacted flags", async () => {
    const { collect } = setup();
    const base = [retire(todoTool("write")), summary()];
    expect(
      await collect([...base, todoTool("read", { tool: "todo_read" })]),
    ).toEqual([]);
    expect(
      await collect([
        ...base,
        todoTool("read", { tool: "todo_read", output: "Result body removed" }),
      ]),
    ).toHaveLength(1);
    const failedRead = todoTool("read", { tool: "todo_read" });
    expect(
      await collect([
        ...base,
        {
          ...failedRead,
          info: {
            ...failedRead.info,
            role: "assistant",
            agent: "build",
            finish: "error",
            error: { name: "MessageOutputLengthError" },
          },
          parts: [...failedRead.parts, ...assistant("text").parts],
        },
      ]),
    ).toHaveLength(1);
  });

  it("uses the active run lease, isolates ordinary and Goal reminders, and ignores the parent Goal for children", async () => {
    const { collect, scopes } = setup();
    const ordinary = todoTool("ordinary");
    const goal = todoTool("goal", {
      todos: [{ content: "Goal task", status: "pending" }],
      workScopeId: "goal:a",
    });
    const child = todoTool("child", {
      todos: [{ content: "Child task", status: "pending" }],
      contextScopeId: "child",
    });
    const history = [
      ordinary,
      goal,
      child,
      ...replies(10),
      ...replies(10, "child-reply", "child"),
    ];
    const [plain] = await collect(history);
    expect(plain.text).toContain("Implement reminder");
    const lease = scopes.acquire("s", "goal:a");
    const [goalDraft] = await collect([
      ...history,
      saved(plain, "plain-anchor"),
      assistant("plain-anchor"),
    ]);
    expect(goalDraft.text).toContain("Goal task");
    expect(goalDraft.text).not.toContain("Implement reminder");
    expect((await collect(history, "child"))[0]?.text).toContain("Child task");
    lease.release();
    expect((await collect(history))[0]?.key).toBe(plain.key);
  });

  it("does not let an identical ordinary list reminder suppress a Goal list", async () => {
    const { collect, scopes } = setup();
    const history = [
      todoTool("ordinary"),
      todoTool("goal", { workScopeId: "goal:a" }),
      ...replies(10),
    ];
    const [ordinary] = await collect(history);
    const applied = [...history, saved(ordinary, "plain"), assistant("plain")];
    scopes.acquire("s", "goal:a");
    const [goal] = await collect(applied);
    expect(goal.text).toBe(ordinary.text);
    expect(goal.key).not.toBe(ordinary.key);
  });

  it("silently skips a source failure and can retry using the shared history without a cached empty list", async () => {
    const scopes = new TodoWorkScopeRegistry();
    let fail = true;
    const collect = createReminderCollector([
      createTodoReminderProvider({
        resolve: () => {
          if (fail) throw new Error("unavailable");
          return scopes.resolve("s");
        },
      }),
    ]);
    const history = [todoTool("write"), ...replies(10)];
    const context = {
      sessionId: "s",
      isSubagent: false,
      history,
      fullHistory: history,
      protectedInputs: [],
    };
    expect(await collect(context)).toEqual([]);
    fail = false;
    expect(await collect(context)).toHaveLength(1);
  });
});
