import type { UiNotice } from "ohbaby-sdk";
import type {
  CompactResult,
  ContextLLMClient,
} from "../../core/context/index.js";
import { serializeHistory } from "../../core/context/serialization.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import { streamChatCompletion } from "../../core/llm-client/index.js";
import {
  scanPromptLikeContent,
  shouldLoadPromptLikeContent,
  type PromptSecurityFinding,
} from "../../core/system-prompt/security/index.js";

export function noticeFromPromptSecurityFinding(
  finding: PromptSecurityFinding,
): Omit<UiNotice, "id" | "createdAt"> {
  const source = finding.sourcePath ?? finding.sourceLabel;
  const sourceName =
    finding.sourceLabel === "Memory" ? "Memory context" : "Custom instructions";
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

export function noticeFromCompactResult(
  sessionId: string,
  result: CompactResult,
): Omit<UiNotice, "id" | "createdAt"> | undefined {
  if (result.status === "not-needed") {
    return undefined;
  }

  const before = formatTokenCount(result.usageBefore.currentTokens);
  const after = formatTokenCount(result.usageAfter.currentTokens);
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
  if (result.status === "inflated") {
    return {
      key: `context:compact:${sessionId}`,
      level: "warning",
      message: `Context compact skipped because the summary was not smaller (${before} -> ${after} tokens).`,
      title: "Context compact warning",
    };
  }

  return {
    key: `context:compact:${sessionId}`,
    level: "info",
    message:
      result.status === "compacted"
        ? `Context compacted: ${before} -> ${after} tokens.`
        : `Context pruned: ${before} -> ${after} tokens.`,
    title:
      result.status === "compacted" ? "Context compacted" : "Context pruned",
  };
}

export function createContextSummaryClient(
  llmClient: LLMClientInstance,
): ContextLLMClient {
  return {
    async generateSummary(input): Promise<string> {
      let summary = "";
      for await (const response of streamChatCompletion(llmClient, [
        { role: "system", content: input.prompt },
        { role: "user", content: serializeHistory(input.history) },
      ])) {
        if (response.isComplete) {
          summary = messageContentToText(response.completeMessage.content);
        }
      }

      const trimmed = summary.trim();
      if (trimmed === "") {
        throw new Error("Context compact summary was empty");
      }
      return trimmed;
    },
  };
}

export function appendMemoryToSystemPrompt(
  systemPrompt: string,
  memory: string,
): string {
  const trimmedMemory = memory.trim();
  if (trimmedMemory === "") {
    return systemPrompt;
  }

  return [systemPrompt.trim(), `<memory>\n${trimmedMemory}\n</memory>`]
    .filter(Boolean)
    .join("\n\n");
}

export function loadMemoryForPrompt(
  memory: string,
  onSecurityFinding?: (finding: PromptSecurityFinding) => void,
): string {
  const trimmedMemory = memory.trim();
  if (trimmedMemory === "") {
    return "";
  }

  const scan = scanPromptLikeContent(trimmedMemory, {
    kind: "memory",
    label: "Memory",
  });
  for (const finding of scan.findings) {
    onSecurityFinding?.(finding);
  }

  return shouldLoadPromptLikeContent(scan) ? trimmedMemory : "";
}

function formatTokenCount(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
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
