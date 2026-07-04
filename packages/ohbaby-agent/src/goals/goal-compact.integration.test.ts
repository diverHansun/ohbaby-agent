import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../bus/index.js";
import { createContextManager } from "../core/context/index.js";
import type {
  CompactResult,
  ContextManager,
  MemoryReader,
  TokenCounter,
} from "../core/context/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import type {
  MessageIdGenerator,
  MessageManager,
  MessageWithParts,
  Part,
} from "../core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import { createSqliteGoalPersistence } from "./persistence.js";
import { GoalService } from "./service.js";
import type {
  GoalPersistencePort,
  GoalTurnOutcome,
  GoalTurnRunner,
} from "./types.js";

// 场景组 5 / 集成点 4（docs/goals/test.md）：goal 与自动 compact 的交互。
// 不变量（docs/goals/architecture.md 第四节）：
// 1. 状态出带 —— compact 压缩消息历史后 goal 记录不丢、用量计数不回退；
// 2. 提醒每轮重生成 —— 旧提醒可被压缩，下一轮提醒仍含 GoalStore 的 objective 原文，
//    即使 compact 摘要把目标复述得面目全非，模型可见的权威目标也与用户语义一致。

const OBJECTIVE =
  "Migrate the billing module from callbacks to async/await and keep test coverage above 90 percent";

// 摘要故意歪曲目标：证明续跑提醒的目标来源是 GoalStore，不是 LLM 复述。
const DISTORTED_SUMMARY =
  "## Goal\n- Rewrite the billing module in Rust\n\n## Next Steps\n1. Delete the existing tests";

function createMessageIds(): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;
  return {
    messageId(): string {
      const id = `message_${String(nextMessageId)}`;
      nextMessageId += 1;
      return id;
    },
    partId(): string {
      const id = `part_${String(nextPartId)}`;
      nextPartId += 1;
      return id;
    },
  };
}

function createClock(): () => number {
  let now = 1_000;
  return () => {
    const current = now;
    now += 1_000;
    return current;
  };
}

function createTokenCounter(): TokenCounter {
  return {
    estimateTokens(content: string): number {
      return content.length;
    },
    getLimit(): number {
      return 1_000_000;
    },
  };
}

async function addTextMessage(
  messageManager: MessageManager,
  input: {
    readonly sessionId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  },
): Promise<void> {
  const message = await messageManager.createMessage({
    sessionId: input.sessionId,
    role: input.role,
    agent: "test",
  });
  await messageManager.appendPart(message.id, {
    type: "text",
    text: input.text,
  });
}

function textParts(history: readonly MessageWithParts[]): readonly Part[] {
  return history.flatMap((message) =>
    message.parts.filter((part) => part.type === "text"),
  );
}

function partText(part: Part): string {
  return "text" in part && typeof part.text === "string" ? part.text : "";
}

function isCompacted(part: Part): boolean {
  return part.time?.compacted !== undefined;
}

describe("goals x compact (integration)", () => {
  let dir: string;
  let persistence: GoalPersistencePort;
  let messageManager: MessageManager;
  let contextManager: ContextManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "goals-compact-"));
    initDatabase({ dbPath: join(dir, "test.db") });
    persistence = createSqliteGoalPersistence(getDatabase());
    messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const memory: MemoryReader = {
      load: () => Promise.resolve({ global: "", merged: "", project: "" }),
    };
    contextManager = createContextManager({
      bus: createBus(),
      llmClient: {
        generateSummary: () => Promise.resolve(DISTORTED_SUMMARY),
      },
      memory,
      messageManager,
      systemPromptProvider: {
        build: () => Promise.resolve("system prompt"),
      },
      tokenCounter: createTokenCounter(),
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { force: true, recursive: true });
  });

  function createRunner(input: {
    readonly prompts: string[];
    readonly onTurn?: (turn: number) => Promise<void>;
  }): GoalTurnRunner {
    return {
      async runTurn(sessionId, promptText): Promise<GoalTurnOutcome> {
        input.prompts.push(promptText);
        const turn = input.prompts.length;
        await addTextMessage(messageManager, {
          role: "user",
          sessionId,
          text: promptText,
        });
        await addTextMessage(messageManager, {
          role: "assistant",
          sessionId,
          text: `turn ${String(turn)} work log: ${"x".repeat(600)}`,
        });
        await input.onTurn?.(turn);
        return { status: "succeeded", tokensUsed: 50 };
      },
    };
  }

  it("keeps driving after a mid-goal compact and regenerates the reminder from the store, not the summary", async () => {
    const sessionId = "goal_compact_s1";
    const prompts: string[] = [];
    let compactResult: CompactResult | undefined;
    const service = new GoalService({ persistence });
    service.attachTurnRunner(
      createRunner({
        prompts,
        onTurn: async (turn) => {
          if (turn === 2) {
            // 模拟 goal 续跑中途触发的自动 compaction。
            compactResult = await contextManager.compact(sessionId, {
              directory: dir,
              force: true,
              modelId: "test-model",
            });
          }
          if (turn === 4) {
            await service.updateGoalFromModel(sessionId, "complete");
          }
        },
      }),
    );

    await service.createGoal(sessionId, {
      actor: "user",
      objective: OBJECTIVE,
    });
    await service.whenIdle(sessionId);

    // compact 真实发生（写入了歪曲的摘要），goal 循环没有被打断。
    expect(compactResult?.status).toBe("compacted");
    expect(prompts).toHaveLength(4);
    expect(await service.getSnapshot(sessionId)).toBeNull();

    // compact 之后的每一轮提醒都含 objective 原文与自审指令，不含摘要的歪曲版本。
    for (const prompt of prompts.slice(2)) {
      expect(prompt).toContain(`<untrusted_objective>\n${OBJECTIVE}`);
      expect(prompt).toContain("Continue working toward the active goal.");
      expect(prompt).not.toContain("Rust");
    }

    const history = await messageManager.listBySession(sessionId);
    const parts = textParts(history);

    // 歪曲的摘要确实进入了模型可见历史——权威目标不靠它。
    const summaryParts = parts.filter(
      (part) => part.metadata?.kind === "context-summary",
    );
    expect(summaryParts).toHaveLength(1);
    expect(partText(summaryParts[0])).toContain("Rust");

    // 旧提醒被 compact 压缩，最新提醒仍活跃在摘要之后（尾部）。
    const reminderParts = parts.filter((part) =>
      partText(part).includes("<untrusted_objective>"),
    );
    expect(reminderParts.length).toBeGreaterThanOrEqual(2);
    expect(reminderParts.some(isCompacted)).toBe(true);
    const activeReminders = reminderParts.filter(
      (part) => !isCompacted(part),
    );
    expect(activeReminders.length).toBeGreaterThanOrEqual(1);
    const activeParts = parts.filter((part) => !isCompacted(part));
    const lastSummaryIndex = activeParts.findIndex(
      (part) => part.metadata?.kind === "context-summary",
    );
    const lastReminderIndex = activeParts.findLastIndex((part) =>
      partText(part).includes(`<untrusted_objective>\n${OBJECTIVE}`),
    );
    expect(lastSummaryIndex).toBeGreaterThanOrEqual(0);
    expect(lastReminderIndex).toBeGreaterThan(lastSummaryIndex);
  });

  it("keeps goal records and usage counters intact across compact and rebuild", async () => {
    const sessionId = "goal_compact_s2";
    const prompts: string[] = [];
    const service = new GoalService({ persistence });
    service.attachTurnRunner(createRunner({ prompts }));

    await service.createGoal(sessionId, {
      actor: "user",
      budgetLimits: { turnBudget: 2 },
      objective: OBJECTIVE,
    });
    await service.whenIdle(sessionId);

    // turn 预算到顶 → driver 自动 pause。
    expect(prompts).toHaveLength(2);
    const paused = await service.getSnapshot(sessionId);
    expect(paused?.status).toBe("paused");

    const compactResult = await contextManager.compact(sessionId, {
      directory: dir,
      force: true,
      modelId: "test-model",
    });
    expect(compactResult.status).toBe("compacted");

    // 模拟重启：从同一 SQLite 全新重建。结构化状态出带存储，compact 不回退用量。
    const rebuilt = new GoalService({ persistence });
    const snapshot = await rebuilt.getSnapshot(sessionId);
    expect(snapshot).toMatchObject({
      objective: OBJECTIVE,
      status: "paused",
      tokensUsed: 100,
      turnsUsed: 2,
    });
    expect(snapshot?.budget.turnBudget).toBe(2);
  });
});
