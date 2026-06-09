import type { UiNotice } from "ohbaby-sdk";
import type {
  CompactResult,
  ContextLLMClient,
} from "../../core/context/index.js";
import {
  appendMemoryToSystemPrompt,
  loadMemoryForPrompt,
} from "../../core/context/index.js";
import { serializeHistory } from "../../core/context/serialization.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import { streamChatCompletion } from "../../core/llm-client/index.js";
import type { PromptSecurityFinding } from "../../core/system-prompt/security/index.js";

export { appendMemoryToSystemPrompt, loadMemoryForPrompt };

export function noticeFromPromptSecurityFinding(
  finding: PromptSecurityFinding,
): Omit<UiNotice, "id" | "createdAt"> {
  const source = finding.sourcePath ?? finding.sourceLabel;
  const sourceName = sourceNameFromPromptSecurityFinding(finding);
  return {
    key: `prompt-security:${source}:${finding.patternId}`,
    level: "warning",
    message: `${finding.sourceLabel} line ${String(finding.line)}: ${
      finding.message
    }`,
    source,
    title:
      finding.action === "omit"
        ? `${sourceName} skipped`
        : `${sourceName} warning`,
  };
}

function sourceNameFromPromptSecurityFinding(
  finding: PromptSecurityFinding,
): string {
  if (finding.sourceLabel === "Memory") {
    return "Memory context";
  }
  if (finding.sourceLabel.startsWith("Tool ")) {
    return "Tool description";
  }
  return "Custom instructions";
}

export function noticeFromCompactResult(
  sessionId: string,
  result: CompactResult,
): Omit<UiNotice, "id" | "createdAt"> | undefined {
  if (
    result.status === "not-needed" ||
    result.status === "compacted" ||
    result.status === "pruned"
  ) {
    return undefined;
  }

  if (result.status === "failed") {
    return {
      key: `context:compact:${sessionId}`,
      level: "warning",
      message: `Context compact failed: ${
        result.error ?? "summary generation failed"
      }. Continuing with the available context.`,
      title: "Context compact warning",
    };
  }
  return {
    key: `context:compact:${sessionId}`,
    level: "warning",
    message:
      "Context compact skipped because the summary was not smaller. Continuing with the available context.",
    title: "Context compact warning",
  };
}

export function createContextSummaryClient(
  llmClient: LLMClientInstance,
): ContextLLMClient {
  return {
    async generateSummary(input): Promise<string> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let summary = "";
        for await (const response of streamChatCompletion(llmClient, [
          { role: "system", content: input.systemPrompt ?? input.prompt },
          { role: "user", content: serializeHistory(input.history) },
          { role: "user", content: input.prompt },
        ])) {
          if (response.isComplete) {
            summary = messageContentToText(response.completeMessage.content);
          }
        }

        const trimmed = summary.trim();
        if (trimmed !== "") {
          return trimmed;
        }
      }
      throw new Error("Context compact summary was empty after retries");
    },
  };
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(textFromContentPart).join("");
  }
  return "";
}

function textFromContentPart(part: unknown): string {
  if (part === null || typeof part !== "object") {
    return "";
  }
  const record = part as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : "";
}
