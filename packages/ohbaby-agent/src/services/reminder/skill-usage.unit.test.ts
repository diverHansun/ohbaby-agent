import { describe, expect, it, vi } from "vitest";
import type {
  MessageWithParts,
  Part,
  ToolPart,
} from "../../core/message/index.js";
import { serializeHistoryMessages } from "../../core/context/serializer.js";
import { arrangeReminderHistory } from "../../core/context/reminder-history.js";
import {
  createReminderCollector,
  type ReminderContext,
  type ReminderDraft,
} from "./index.js";
import { createSkillUsageReminderProvider } from "./skill-usage.js";

function message(
  id: string,
  role: "user" | "assistant",
  parts: readonly Partial<Part>[],
  scope?: string,
): MessageWithParts {
  return {
    info: {
      id,
      sessionId: "s",
      contextScopeId: scope,
      role,
      agent: "build",
      time: { created: 1, completed: 2 },
    },
    parts: parts.map(
      (part, index) =>
        ({
          id: `${id}-${String(index)}`,
          messageId: id,
          sessionId: "s",
          contextScopeId: scope,
          orderIndex: index,
          ...part,
        }) as Part,
    ),
  };
}
function skill(name: string, scope?: string): MessageWithParts {
  return message(
    `skill-${name}`,
    "assistant",
    [
      {
        type: "tool",
        tool: "skill",
        callId: `call-${name}`,
        state: {
          status: "completed",
          input: { name: "requested-alias" },
          output: `Body of ${name}`,
          time: { start: 1, end: 2 },
          metadata: { name, uiToolSource: "skill" },
        },
      } as Partial<ToolPart>,
    ],
    scope,
  );
}
function slash(name: string, scope?: string): MessageWithParts {
  return message(
    `slash-${name}`,
    "user",
    [
      {
        type: "text",
        text: `Body of ${name}`,
        metadata: { skillUsage: { name, source: "slash" } },
      },
    ],
    scope,
  );
}
function summary(id = "compaction-new", scope?: string): MessageWithParts {
  return message(
    `summary-${id}`,
    "assistant",
    [
      {
        type: "text",
        text: "summary",
        synthetic: true,
        metadata: { kind: "context-summary", compactionId: id },
      },
    ],
    scope,
  );
}
function retire(m: MessageWithParts): MessageWithParts {
  return {
    ...m,
    parts: m.parts.map((part) => ({
      ...part,
      time: { ...part.time, compacted: 10 },
    })),
  };
}
function reminder(key: string, anchor = "owner"): MessageWithParts {
  return message(`reminder-${key}`, "user", [
    {
      type: "text",
      text: "reminder",
      synthetic: true,
      metadata: {
        kind: "system-reminder:v1",
        reminderType: "skill-usage",
        key,
        anchorAssistantId: anchor,
      },
    },
  ]);
}
// Fixture shape follows the provider sources.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(modelAllowed = true) {
  const get = vi.fn<
    Parameters<typeof createSkillUsageReminderProvider>[0]["getSkill"]
  >((name: string) =>
    Promise.resolve({
      name,
      userInvocable: true,
      disableModelInvocation: false,
    }),
  );
  const canInvokeSkill = vi.fn(() => Promise.resolve(modelAllowed));
  const provider = createSkillUsageReminderProvider({
    getSkill: get,
    canInvokeSkill,
  });
  return { get, canInvokeSkill, collect: createReminderCollector([provider]) };
}
async function collectHistory(
  f: ReturnType<typeof setup>,
  fullHistory: readonly MessageWithParts[],
  patch: Partial<ReminderContext> = {},
): Promise<readonly ReminderDraft[]> {
  const history = arrangeReminderHistory(fullHistory).filter(
    (m) => serializeHistoryMessages([m]).length > 0,
  );
  return f.collect({
    sessionId: "s",
    isSubagent: false,
    history,
    fullHistory,
    protectedInputs: [],
    ...patch,
  });
}

describe("skill usage reminder", () => {
  it("uses successful actual names and only the newest committed visible compaction boundary", async () => {
    const f = setup();
    const history = [
      retire(skill("actual-name")),
      retire(slash("slash-name")),
      retire(summary("old")),
      summary("new"),
    ];
    const result = await collectHistory(f, history);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "skill-usage", key: "new" });
    expect(result[0]?.text).toContain("actual-name");
    expect(result[0]?.text).toContain("slash-name");
    expect(result[0]?.text).not.toContain("requested-alias");
    expect(f.get.mock.calls.map(([name]) => name)).toEqual([
      "slash-name",
      "actual-name",
    ]);
  });
  it("needs a committed summary, missing bodies and successful usage rather than a tool request or resource", async () => {
    const f = setup();
    expect(await collectHistory(f, [retire(skill("review"))])).toEqual([]);
    expect(await collectHistory(f, [skill("review"), summary()])).toEqual([]);
    expect(await collectHistory(f, [slash("review"), summary()])).toEqual([]);
    for (const status of ["error", "running", "pending", "aborted"] as const) {
      const used = skill("review");
      const part = used.parts[0] as ToolPart;
      const failed = {
        ...used,
        parts: [{ ...part, state: { ...part.state, status } } as ToolPart],
      };
      expect(await collectHistory(f, [retire(failed), summary()])).toEqual([]);
    }
    const resource = skill("review");
    expect(
      await collectHistory(f, [
        retire({
          ...resource,
          parts: resource.parts.map(
            (p) => ({ ...p, tool: "skill_resource" }) as Part,
          ),
        }),
        summary(),
      ]),
    ).toEqual([]);
    const spoof = skill("review");
    expect(
      await collectHistory(f, [
        retire({
          ...spoof,
          parts: spoof.parts.map((p) =>
            p.type === "tool"
              ? ({
                  ...p,
                  state: {
                    ...p.state,
                    metadata: { name: "review", uiToolSource: "mcp" },
                  },
                } as ToolPart)
              : p,
          ),
        }),
        summary(),
      ]),
    ).toEqual([]);
  });
  it("does not infer usage from display text, naming hints or unrecognized slash metadata", async () => {
    const f = setup();
    for (const metadata of [
      { displayText: "/review", namingSource: { skillName: "review" } },
      { skillUsage: { name: "review", source: "user-text" } },
      { skillUsage: { name: "", source: "slash" } },
    ])
      expect(
        await collectHistory(f, [
          retire(
            message("plain", "user", [
              { type: "text", text: "review", metadata },
            ]),
          ),
          summary(),
        ]),
      ).toEqual([]);
    const used = retire(skill("review"));
    const ignored = {
      ...summary(),
      parts: summary().parts.map((part) => ({ ...part, ignored: true })),
    };
    expect(await collectHistory(f, [used, ignored])).toEqual([]);
    expect(await collectHistory(f, [used, retire(summary())])).toEqual([]);
  });

  it("tests actual visible parts, including protected slash text, ignored and empty bodies", async () => {
    const f = setup();
    const used = retire(skill("review"));
    expect(
      await collectHistory(f, [used, summary()], {
        protectedInputs: [slash("review")],
      }),
    ).toEqual([]);
    for (const body of [
      message("ignored", "user", [
        {
          type: "text",
          text: "body",
          ignored: true,
          metadata: { skillUsage: { name: "review", source: "slash" } },
        },
      ]),
      message("empty", "user", [
        {
          type: "text",
          text: "",
          metadata: { skillUsage: { name: "review", source: "slash" } },
        },
      ]),
      retire(slash("review")),
    ])
      expect(
        await collectHistory(f, [used, summary()], { protectedInputs: [body] }),
      ).toHaveLength(1);
    expect(
      await collectHistory(f, [used, summary()], {
        protectedInputs: [slash("review", "child")],
      }),
    ).toHaveLength(1);
  });
  it("does not treat a failed assistant's hidden skill body as visible even when failure text is visible", async () => {
    const f = setup();
    const used = skill("review");
    const failed: MessageWithParts = {
      ...used,
      info: {
        ...used.info,
        role: "assistant",
        agent: "build",
        finish: "error",
        error: { name: "MessageOutputLengthError" },
      },
      parts: [
        ...used.parts,
        {
          ...slash("unused").parts[0],
          id: "visible",
          type: "text",
          text: "partial answer",
        },
      ],
    };
    expect(serializeHistoryMessages([failed])).toHaveLength(1);
    expect(await collectHistory(f, [failed, summary()])).toHaveLength(1);
  });
  it("does not count native tool results before the owner is committed", async () => {
    const f = setup();
    const used = skill("review");
    const pending: MessageWithParts = {
      ...used,
      info: { ...used.info, time: { created: 1 } },
      parts: [
        ...used.parts,
        {
          id: "native",
          messageId: used.info.id,
          sessionId: "s",
          orderIndex: 1,
          type: "model-state",
          modelState: {
            version: 1,
            origin: {
              provider: "openai-compatible",
              model: "test",
              protocol: "openai-compatible",
              endpoint: "https://example.com",
            },
            output: { protocol: "openai-compatible" },
            estimate: { tokens: 0, source: "text" },
          },
        },
      ],
    };
    // The prepared history has already removed uncommitted native owners.
    expect(
      await collectHistory(f, [retire(used), summary()], {
        history: [summary()],
        protectedInputs: [pending],
      }),
    ).toHaveLength(1);
  });
  it("keeps event replay facts through retirement and restart, but orphan or failed owners never deduplicate", async () => {
    const full = [retire(skill("review")), summary()];
    const r = reminder("compaction-new");
    expect(await collectHistory(setup(), [...full, r])).toHaveLength(1);
    const owner = message("owner", "assistant", [
      { type: "text", text: "answer" },
    ]);
    expect(await collectHistory(setup(), [...full, r, owner])).toEqual([]);
    expect(
      await collectHistory(setup(), [...full, retire(r), retire(owner)]),
    ).toEqual([]);
    expect(
      await collectHistory(setup(), [
        ...full,
        r,
        owner,
        retire(skill("another-skill")),
      ]),
    ).toEqual([]);
    const failed: MessageWithParts = {
      ...owner,
      info: {
        ...owner.info,
        role: "assistant",
        agent: "build",
        finish: "error",
        error: { name: "Unknown", message: "failed" },
      },
    };
    expect(await collectHistory(setup(), [...full, r, failed])).toHaveLength(1);
    expect(
      await collectHistory(setup(), [
        ...full,
        r,
        owner,
        retire(summary()),
        summary("next"),
      ]),
    ).toMatchObject([{ key: "next" }]);
  });
  it("respects current model capability and exposes only a current user menu when applicable", async () => {
    const f = setup();
    f.get.mockResolvedValue({
      userInvocable: true,
      disableModelInvocation: true,
    });
    const history = [retire(skill("user-only")), summary()];
    let result = await collectHistory(f, history);
    expect(result[0]?.text).toContain("/skills");
    expect(result[0]?.text).not.toContain("skill(name=");
    expect(result[0]?.text).not.toContain("skill_resource");
    const blocked = setup(false);
    result = await collectHistory(blocked, history);
    expect(result[0]?.text).toContain("/skills");
    expect(result[0]?.text).not.toContain("skill(name=");
    blocked.get.mockResolvedValue({
      userInvocable: false,
      disableModelInvocation: false,
    });
    expect((await collectHistory(blocked, history))[0]?.text).toContain(
      "no currently available reread entry",
    );
    blocked.get.mockResolvedValue(undefined);
    expect((await collectHistory(blocked, history))[0]?.text).toContain(
      "no currently available reread entry",
    );
  });
  it("isolates parent, child and sibling usage and does not invent a child slash entry", async () => {
    const f = setup(false);
    const all = [
      retire(skill("parent")),
      summary(),
      retire(slash("child", "child")),
      summary("child-c", "child"),
      retire(skill("sibling", "sibling")),
      summary("sibling-c", "sibling"),
    ];
    const primary = await collectHistory(f, all);
    expect(primary[0]?.text).toContain("parent");
    expect(primary[0]?.text).not.toContain("child");
    const child = await collectHistory(f, all, {
      contextScopeId: "child",
      isSubagent: true,
    });
    expect(child[0]?.key).toBe("child-c");
    expect(child[0]?.text).toContain("child");
    expect(child[0]?.text).not.toContain("parent");
    expect(child[0]?.text).not.toContain("/skills");
  });
  it("separates same-named bodies in parent, child and sibling scopes", async () => {
    const full = [
      retire(skill("shared")),
      summary(),
      slash("shared", "child"),
      summary("child-boundary", "child"),
      slash("shared", "sibling"),
    ];
    expect(await collectHistory(setup(), full)).toHaveLength(1);
    expect(
      await collectHistory(setup(), full, {
        contextScopeId: "child",
        isSubagent: true,
      }),
    ).toEqual([]);
    const reverse = [
      slash("shared"),
      summary(),
      retire(skill("shared", "child")),
      summary("child-boundary", "child"),
      slash("shared", "sibling"),
    ];
    expect(await collectHistory(setup(), reverse)).toEqual([]);
    expect(
      await collectHistory(setup(), reverse, {
        contextScopeId: "child",
        isSubagent: true,
      }),
    ).toMatchObject([{ key: "child-boundary" }]);
  });

  it("lists at most 20 complete recent names, deduplicates use and never loads content", async () => {
    const f = setup();
    const names = Array.from(
      { length: 22 },
      (_, i) => `namespace:skill-${String(i)}-long-name`,
    );
    const result = await collectHistory(f, [
      ...names.map((n) => retire(skill(n))),
      retire(slash(names[0])),
      summary(),
    ]);
    expect(f.get).toHaveBeenCalledTimes(20);
    expect(result[0]?.text).toContain(names[0]);
    expect(result[0]?.text).toContain(names[21]);
    expect(result[0]?.text).not.toContain(names[1]);
    expect(result[0]?.text).toContain("2 omitted");
    expect(result[0]?.text).toContain("Previously used");
    expect(result[0]?.text).toContain("still need");
  });
  it("skips source failures without consuming the event", async () => {
    const f = setup();
    const history = [retire(skill("review")), summary()];
    f.get.mockRejectedValueOnce(new Error("unavailable"));
    expect(await collectHistory(f, history)).toEqual([]);
    expect(await collectHistory(f, history)).toHaveLength(1);
  });
});
