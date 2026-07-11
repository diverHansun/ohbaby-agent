import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  streamChatCompletion,
  type LLMClientInstance,
  type StreamingResponse,
} from "../core/llm-client/index.js";
import { PRIMARY_BASE_PROMPT } from "../core/system-prompt/prompts/primary/base.js";
import { createInterfaceProvider } from "../services/interface-providers/index.js";

const runRealEval =
  process.env.OHBABY_GOAL_REAL_EVAL === "1" ? describe : describe.skip;

const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const MODEL = "glm-5.1";
const FINAL_MARKER = "OHBABY_GOAL_COMPLETE_ORDER_OK";

const tools: ChatCompletionTool[] = [
  {
    function: {
      description: "Read the current execution state of delegated subagents.",
      name: "subagent_status",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
    },
    type: "function",
  },
  {
    function: {
      description:
        "Update the active goal. Complete is allowed only after all delegated work is non-running and verification is done.",
      name: "UpdateGoal",
      parameters: {
        additionalProperties: false,
        properties: {
          status: { enum: ["paused", "complete"], type: "string" },
        },
        required: ["status"],
        type: "object",
      },
    },
    type: "function",
  },
  {
    function: {
      description:
        "Record one explicit user, system, or developer budget. Never invent a budget.",
      name: "SetGoalBudget",
      parameters: {
        additionalProperties: false,
        properties: {
          unit: { enum: ["turns", "tokens", "minutes"], type: "string" },
          value: { exclusiveMinimum: 0, type: "number" },
        },
        required: ["value", "unit"],
        type: "object",
      },
    },
    type: "function",
  },
];

runRealEval("goal completion real model eval", () => {
  beforeAll(() => {
    loadDotenv({ path: path.join(process.cwd(), ".env") });
  });

  it(
    "waits for delegated execution, completes the goal, then gives the final answer without inventing a budget",
    async () => {
      const client = realClient();
      const messages: ChatCompletionMessageParam[] = [
        { content: PRIMARY_BASE_PROMPT, role: "system" },
        {
          content: [
            "You are in an active goal continuation. The objective and verification are finished,",
            "but delegated subagent sub_1 is still running and may mutate the workspace.",
            "No user, system, or developer message specified any budget.",
            "Follow the system lifecycle rules using the available tools. Once the subagent is",
            `non-running and the goal is complete, end with a concise final answer containing ${FINAL_MARKER}.`,
          ].join(" "),
          role: "user",
        },
      ];
      let observedCompletedSubagent = false;
      let statusCalls = 0;
      let goalCompleted = false;
      let finalText = "";

      for (let step = 0; step < 8; step += 1) {
        const response = await completeResponse(client, messages);
        messages.push(response.completeMessage);
        const calls = response.parsedToolCalls ?? [];

        if (calls.length === 0) {
          if (goalCompleted) {
            finalText = messageText(response.completeMessage);
            break;
          }
          messages.push({
            content: "Continue the active goal and use the lifecycle tools required by the system prompt.",
            role: "user",
          });
          continue;
        }

        const completedObservedBeforeBatch = observedCompletedSubagent;
        let completedDeliveredThisBatch = false;
        for (const call of calls) {
          if (call.name === "SetGoalBudget") {
            throw new Error("Model invented a goal budget when no authority specified one.");
          }
          if (call.name === "subagent_status") {
            statusCalls += 1;
            const completed = statusCalls >= 2;
            completedDeliveredThisBatch ||= completed;
            messages.push({
              content: completed
                ? "sub_1 status=completed; no delegated execution is running"
                : "sub_1 status=running; it may still mutate the workspace; check again before completing",
              role: "tool",
              tool_call_id: call.id,
            });
            continue;
          }
          if (call.name === "UpdateGoal") {
            if (call.arguments.status === "complete") {
              assertCompletionWasObservedBeforeBatch(
                completedObservedBeforeBatch,
                completedDeliveredThisBatch,
              );
              goalCompleted = true;
              messages.push({
                content: "Goal completed and cleared. Give the user the final answer now.",
                role: "tool",
                tool_call_id: call.id,
              });
              continue;
            }
            throw new Error(`Unexpected UpdateGoal status: ${String(call.arguments.status)}`);
          }
          throw new Error(`Unexpected tool call: ${call.name}`);
        }
        observedCompletedSubagent ||= completedDeliveredThisBatch;
      }

      expect(statusCalls).toBeGreaterThanOrEqual(2);
      expect(goalCompleted).toBe(true);
      expect(normalize(finalText)).toContain(normalize(FINAL_MARKER));
    },
    360_000,
  );
});

describe("goal completion eval ordering guard", () => {
  it("rejects complete when completed status is delivered in the same tool batch", () => {
    const completedObservedBeforeBatch = false;
    const completedDeliveredThisBatch = true;

    expect(() => {
      assertCompletionWasObservedBeforeBatch(
        completedObservedBeforeBatch,
        completedDeliveredThisBatch,
      );
    }).toThrow("prior model step");
    expect(completedDeliveredThisBatch).toBe(true);
  });

  it("allows complete after a prior model step observed completed status", () => {
    expect(() => {
      assertCompletionWasObservedBeforeBatch(true, false);
    }).not.toThrow();
  });
});

function realClient(): LLMClientInstance {
  const apiKey = process.env.ZAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Set ZAI_API_KEY in the root .env for the goal real eval.");
  }
  return {
    config: {
      apiKeyEnv: "ZAI_API_KEY",
      baseUrl: BASE_URL,
      interfaceProvider: "openai-compatible",
      maxTokens: 2_048,
      model: process.env.OHBABY_GOAL_REAL_MODEL ?? MODEL,
      provider: "zhipu",
      temperature: 0,
    },
    provider: createInterfaceProvider({
      apiKey,
      baseUrl: BASE_URL,
      id: "zhipu",
      interfaceProvider: "openai-compatible",
    }),
  };
}

async function completeResponse(
  client: LLMClientInstance,
  messages: ChatCompletionMessageParam[],
): Promise<StreamingResponse> {
  let completed: StreamingResponse | undefined;
  for await (const response of streamChatCompletion(client, messages, {
    maxTokens: 2_048,
    tools,
  })) {
    if (response.isComplete) completed = response;
  }
  if (completed === undefined) {
    throw new Error("Real goal eval returned no completed response.");
  }
  return completed;
}

function messageText(message: ChatCompletionMessageParam): string {
  if (!("content" in message)) return "";
  return typeof message.content === "string" ? message.content : "";
}

function normalize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
}

function assertCompletionWasObservedBeforeBatch(
  observedBeforeBatch: boolean,
  deliveredThisBatch: boolean,
): void {
  if (!observedBeforeBatch) {
    throw new Error(
      `${deliveredThisBatch ? "A completed status delivered in the same tool batch is not yet observed. " : ""}UpdateGoal(complete) requires a completed subagent status observed in a prior model step.`,
    );
  }
}
