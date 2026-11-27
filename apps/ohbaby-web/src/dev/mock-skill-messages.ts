import type { UiMessage, UiPromptSubmission } from "ohbaby-sdk";

/**
 * `?mock=skill-messages` puts every user-bubble shape the skill UX has to
 * render into one session: skill calls with and without a request, long and
 * multi-line ones, plain long text, old slash messages without a marker, a
 * marker that does not match the text, markdown symbols and a long URL.
 */
const iso = (minutesAgo: number): string =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const longRequest = Array.from(
  { length: 18 },
  (_, index) =>
    `第 ${String(index + 1)} 行：检查 packages/ohbaby-agent/src/skill/registry.ts 里加载顺序和缓存失效的处理。`,
).join("\n");

/** One user message as the backend sends it: `/name 原话`, plus the marker. */
function skillUser(
  id: string,
  minutesAgo: number,
  name: string,
  request: string,
): UiMessage {
  const text = request === "" ? `/${name}` : `/${name} ${request}`;
  return {
    id,
    role: "user",
    createdAt: iso(minutesAgo),
    parts: [
      {
        type: "text",
        text,
        metadata: { displayText: text, skillMarker: { name } },
      },
    ],
  };
}

function plainUser(id: string, minutesAgo: number, text: string): UiMessage {
  return {
    id,
    role: "user",
    createdAt: iso(minutesAgo),
    parts: [{ type: "text", text }],
  };
}

function reply(id: string, minutesAgo: number, text: string): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: iso(minutesAgo),
    status: "completed",
    parts: [{ type: "text", text }],
  };
}

export function skillMessages(): readonly UiMessage[] {
  return [
    skillUser("sk_u1", 40, "code-review", "看看这次改动有没有漏掉错误处理"),
    reply("sk_a1", 40, "我先读一下 diff，再逐条对照规范。"),
    skillUser("sk_u2", 36, "status-report", ""),
    reply("sk_a2", 36, "这周完成了三项，还有一项在等评审。"),
    skillUser(
      "sk_u3",
      32,
      "code-review",
      "重点看这几处：\n  1. 锁的范围\n  2. 回滚路径\n\n别管格式问题。",
    ),
    reply("sk_a3", 32, "好的，只看锁和回滚。"),
    skillUser(
      "sk_u4",
      28,
      "release-notes-from-merged-pull-requests-since-last-tag",
      longRequest,
    ),
    reply("sk_a4", 28, "我按模块把这些检查点归一下类。"),
    plainUser("sk_u5", 24, longRequest.replaceAll("检查", "确认")),
    reply("sk_a5", 24, "收到，逐行确认。"),
    // Sent before the upgrade: the full text, no marker.
    plainUser("sk_u6", 20, "/code-review 旧版本发出的 slash 消息，没有标记"),
    reply("sk_a6", 20, "旧消息照常显示全文。"),
    // The skill was deleted while this one waited in the queue.
    plainUser("sk_u7", 16, "/code-review x"),
    reply("sk_a7", 16, "没有这个 skill，按普通文字理解。"),
    {
      id: "sk_u8",
      role: "user",
      createdAt: iso(12),
      parts: [
        {
          type: "text",
          text: "开头不是 slash，但带了标记",
          metadata: { skillMarker: { name: "code-review" } },
        },
      ],
    },
    reply("sk_a8", 12, "标记对不上，就当普通消息。"),
    plainUser(
      "sk_u9",
      8,
      "# 不是标题\n**不加粗** _不斜体_ `不是代码`\n- 不是列表\n> 不是引用\n| a | b |\n|---|---|",
    ),
    reply("sk_a9", 8, "这些符号原样显示。"),
    plainUser(
      "sk_u10",
      4,
      "看这个链接 https://example.com/very/long/path/that/keeps/going/and/going/without/any/break/at/all/so/it/must/wrap/inside/the/bubble?query=1&other=2",
    ),
    reply("sk_a10", 4, "长网址自动换行。"),
  ];
}

/** A finished prompt for every user message, so each bubble can be edited. */
export function skillPrompts(sessionId: string): readonly UiPromptSubmission[] {
  return skillMessages()
    .filter((message) => message.role === "user")
    .map((message) => {
      const first = message.parts[0];
      const text = first.type === "text" ? first.text : "";
      return {
        promptId: `prompt_${message.id}`,
        clientRequestId: `request_${message.id}`,
        scopeKey: sessionId,
        sessionId,
        userMessageId: message.id,
        text,
        status: "succeeded",
        createdAt: message.createdAt,
        acceptedAt: message.createdAt,
        updatedAt: message.createdAt,
        endedAt: message.createdAt,
      };
    });
}
