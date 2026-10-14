import type { UiNotice } from "ohbaby-sdk";
import type {
  CompactResult,
  ContextLLMClient,
  SummaryRequestResult,
} from "../../core/context/index.js";
import {
  appendMemoryToSystemPrompt,
  loadMemoryForPrompt,
} from "../../core/context/index.js";
import type { SummaryRequestRecord } from "../../core/llm-client/types.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import { streamResponse } from "../../core/llm-client/index.js";
import type { PromptSecurityFinding } from "../../core/system-prompt/security/index.js";
import { redactPromptSecrets } from "../../services/session/prompt-sanitizer.js";

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
  if (result.status === "not-needed" || result.status === "compacted") {
    return undefined;
  }

  if (result.status === "failed") {
    return {
      key: `context:compact:${sessionId}`,
      level: "warning",
      message: `Context compact failed: ${
        result.error ?? "summary generation failed"
      }.`,
      title: "Context compact warning",
    };
  }
  return {
    key: `context:compact:${sessionId}`,
    level: "warning",
    message: "Context compact failed because the summary was not smaller.",
    title: "Context compact warning",
  };
}

export function createContextSummaryClient(
  llmClient: LLMClientInstance,
): ContextLLMClient {
  return {
    async generateSummary(input): Promise<SummaryRequestResult> {
      throwIfSummaryAborted(input.signal);
      const settings = input.request.settings;
      if (!settings)
        throw new Error("Summary request is missing resolved settings");
      let summary = "";
      let completedNormally = false;
      const requests: SummaryRequestRecord[] = [];
      let summaryFailure: string | undefined;
      try {
        for await (const response of streamResponse(
          llmClient,
          input.request.messages,
          {
            preparedSettings: settings,
            tools: input.request.tools,
            purpose: "context-summary",
            maxTokens: settings.maxTokens,
            retry: { maxRetriesPerStep: 0 },
            sessionId: input.sessionId,
            contextScopeId: input.contextScopeId,
            signal: input.signal,
            summaryOwner: {
              compactionId: input.compactionId,
              messageId: input.summaryMessageId,
              attempt: input.attempt,
              inputIds: input.request.inputIds,
            },
            onSummaryRequestRecord(record) {
              requests.push(record);
              input.onRequestRecord?.(record);
            },
          },
        )) {
          if (response.streamStopReason === "user_aborted")
            throw summaryAbortError();
          if (
            (response.parsedToolCalls?.length ?? 0) > 0 ||
            response.finishReason === "tool_calls"
          ) {
            summaryFailure = "Context compact summary attempted a tool call";
          } else if (
            response.finishReason !== undefined &&
            response.finishReason !== "stop"
          ) {
            summaryFailure ??=
              "Context compact summary did not finish normally";
          }
          if (response.isComplete) {
            completedNormally = response.finishReason === "stop";
            summary = messageContentToText(response.messageSnapshot.content);
          }
        }
      } catch (error) {
        if (summaryFailure && !input.signal?.aborted)
          throw new Error(summaryFailure, {
            cause: error,
          });
        throw error;
      }
      throwIfSummaryAborted(input.signal);
      if (summaryFailure) throw new Error(summaryFailure);
      if (!completedNormally)
        throw new Error("Context compact summary did not finish normally");
      const text = redactPromptSecrets(summary).trim();
      if (!text) throw new Error("Context compact summary was empty");
      return { text, summaryMessageId: input.summaryMessageId, requests };
    },
  };
}

function throwIfSummaryAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw summaryAbortError();
  }
}

function summaryAbortError(): Error {
  const error = new Error("Context compact summary was aborted");
  error.name = "AbortError";
  return error;
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
