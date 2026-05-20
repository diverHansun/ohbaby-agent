import {
  COMPRESSION_PRESERVE_RATIO,
  COMPRESSION_THRESHOLD,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  SUMMARY_AGENT_NAME,
} from "./constants.js";
import { COMPRESSION_PROMPT } from "./compression-prompt.js";
import { ContextEvent } from "./events.js";
import {
  getCompletedToolOutput,
  isContextSummary,
  serializeHistory,
  serializeMessage,
} from "./serialization.js";
import type {
  AssembledContext,
  CompactOptions,
  CompactResult,
  CompactStatus,
  CompressionResult,
  ContextManager,
  ContextManagerOptions,
  ContextUsage,
  PruneResult,
  TokenCounter,
} from "./types.js";
import type { MessageWithParts, Part } from "../message/index.js";
import type { MergedMemory } from "../memory/index.js";

const EMPTY_MEMORY: MergedMemory = { global: "", project: "", merged: "" };

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokenCount(
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
  content: string,
): number {
  return Math.max(0, tokenCounter.estimateTokens(content));
}

export function getContextUsage(
  context: Pick<AssembledContext, "estimatedTokens">,
  modelId: string,
  tokenCounter: Pick<TokenCounter, "getLimit">,
  compressionThreshold = COMPRESSION_THRESHOLD,
): ContextUsage {
  const contextLimit = tokenCounter.getLimit(modelId);
  const currentTokens = context.estimatedTokens;
  const usageRatio = contextLimit === 0 ? 1 : currentTokens / contextLimit;

  return {
    currentTokens,
    contextLimit,
    modelId,
    remainingTokens: Math.max(0, contextLimit - currentTokens),
    shouldCompress: usageRatio >= compressionThreshold,
    usageRatio,
  };
}

function getHistoryToCompress(input: {
  readonly history: readonly MessageWithParts[];
  readonly preserveRatio: number;
  readonly tokenCounter: TokenCounter;
}): readonly MessageWithParts[] {
  const fullTokens = tokenCount(
    input.tokenCounter,
    serializeHistory(input.history),
  );
  const preserveTarget = Math.floor(fullTokens * input.preserveRatio);
  let preservedTokens = 0;
  let splitIndex = input.history.length;

  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const messageTokens = tokenCount(
      input.tokenCounter,
      serializeMessage(input.history[index]),
    );
    if (
      splitIndex === input.history.length ||
      preservedTokens + messageTokens <= preserveTarget
    ) {
      preservedTokens += messageTokens;
      splitIndex = index;
      continue;
    }
    break;
  }

  return input.history.slice(0, splitIndex);
}

function getActiveHistory(
  history: readonly MessageWithParts[],
): MessageWithParts[] {
  const active = history.flatMap((message) => {
    const parts = message.parts.filter(
      (part) => part.time?.compacted === undefined,
    );
    if (parts.length === 0) {
      return [];
    }

    return [{ info: message.info, parts }];
  });

  const summaries = active.filter(isContextSummary);
  if (summaries.length === 0) {
    return active;
  }

  return [
    ...summaries,
    ...active.filter((message) => !isContextSummary(message)),
  ];
}

export function createContextManager(
  options: ContextManagerOptions,
): ContextManager {
  const now = options.now ?? Date.now;
  const compressionThreshold =
    options.compressionThreshold ?? COMPRESSION_THRESHOLD;
  const compressionPreserveRatio =
    options.compressionPreserveRatio ?? COMPRESSION_PRESERVE_RATIO;
  const pruneProtectTokens = options.pruneProtectTokens ?? PRUNE_PROTECT_TOKENS;
  const pruneMinimumTokens = options.pruneMinimumTokens ?? PRUNE_MINIMUM_TOKENS;
  const summaryAgentName = options.summaryAgentName ?? SUMMARY_AGENT_NAME;

  async function assemble(
    sessionId: string,
    directory: string,
    isSubagent = false,
  ): Promise<AssembledContext> {
    let memory = EMPTY_MEMORY;
    if (!isSubagent) {
      try {
        memory = await options.memory.load(directory);
      } catch (error) {
        options.onWarning?.("Unable to load memory for context", error);
      }
    }

    const [systemPrompt, rawHistory] = await Promise.all([
      options.systemPromptProvider.build({ sessionId, directory, isSubagent }),
      options.messageManager.listBySession(sessionId),
    ]);
    const history = getActiveHistory(rawHistory);
    const estimatedTokens = tokenCount(
      options.tokenCounter,
      [systemPrompt, memory.merged, serializeHistory(history)]
        .filter(Boolean)
        .join("\n\n"),
    );

    return {
      systemPrompt,
      memory,
      history,
      estimatedTokens,
      hasSummary: rawHistory.some(isContextSummary),
      assembledAt: now(),
      sessionId,
    };
  }

  async function prune(sessionId: string): Promise<PruneResult> {
    const history = await options.messageManager.listBySession(sessionId);
    const candidates: { readonly part: Part; readonly tokens: number }[] = [];

    for (const message of history) {
      for (const part of message.parts) {
        const output = getCompletedToolOutput(part);
        if (output !== undefined) {
          candidates.push({
            part,
            tokens: tokenCount(options.tokenCounter, output),
          });
        }
      }
    }

    let protectedTokens = 0;
    let protectedCount = 0;
    const prunable: { readonly part: Part; readonly tokens: number }[] = [];

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (protectedTokens < pruneProtectTokens) {
        protectedTokens += candidate.tokens;
        protectedCount += 1;
      } else {
        prunable.push(candidate);
      }
    }

    const freedTokens = prunable.reduce(
      (sum, candidate) => sum + candidate.tokens,
      0,
    );
    if (freedTokens < pruneMinimumTokens) {
      const result = {
        prunedCount: 0,
        freedTokens: 0,
        protectedCount,
        totalScanned: candidates.length,
      };
      options.bus.publish(ContextEvent.Pruned, { sessionId, result });
      return result;
    }

    const compactedAt = now();
    for (const candidate of prunable) {
      await options.messageManager.updatePart(candidate.part.id, {
        time: { ...candidate.part.time, compacted: compactedAt },
      });
    }

    const result = {
      prunedCount: prunable.length,
      freedTokens,
      protectedCount,
      totalScanned: candidates.length,
    };
    options.bus.publish(ContextEvent.Pruned, { sessionId, result });
    return result;
  }

  async function summarizeActiveHistory(
    sessionId: string,
  ): Promise<CompressionResult> {
    const activeHistory = (
      await options.messageManager.listBySession(sessionId)
    ).filter((message) => !isContextSummary(message));
    const activeTokens = tokenCount(
      options.tokenCounter,
      serializeHistory(activeHistory),
    );
    if (activeHistory.length <= 2) {
      return {
        status: "skipped",
        originalTokens: activeTokens,
        newTokens: activeTokens,
        savedTokens: 0,
      };
    }

    const historyToCompress = getHistoryToCompress({
      history: activeHistory,
      preserveRatio: compressionPreserveRatio,
      tokenCounter: options.tokenCounter,
    });
    const originalTokens = tokenCount(
      options.tokenCounter,
      serializeHistory(historyToCompress),
    );
    if (historyToCompress.length === 0 || originalTokens === 0) {
      return {
        status: "skipped",
        originalTokens,
        newTokens: originalTokens,
        savedTokens: 0,
      };
    }

    let snapshot: string;
    try {
      snapshot = await options.llmClient.generateSummary({
        sessionId,
        prompt: COMPRESSION_PROMPT,
        history: historyToCompress,
      });
    } catch (error) {
      return {
        status: "failed",
        originalTokens,
        newTokens: originalTokens,
        savedTokens: 0,
        error: errorToMessage(error),
      };
    }

    const newTokens = tokenCount(options.tokenCounter, snapshot);
    if (newTokens >= originalTokens) {
      return {
        status: "inflated",
        originalTokens,
        newTokens,
        savedTokens: 0,
      };
    }

    const summary = await options.messageManager.createMessage({
      sessionId,
      role: "assistant",
      agent: summaryAgentName,
    });
    await options.messageManager.appendPart(summary.id, {
      type: "text",
      text: snapshot,
      synthetic: true,
      metadata: { kind: "context-summary" },
    });
    const compactedAt = now();
    for (const message of historyToCompress) {
      for (const part of message.parts) {
        if (part.time?.compacted === undefined) {
          await options.messageManager.updatePart(part.id, {
            time: { ...part.time, compacted: compactedAt },
          });
        }
      }
    }

    const result = {
      status: "compressed",
      originalTokens,
      newTokens,
      savedTokens: originalTokens - newTokens,
      summaryMessageId: summary.id,
    } satisfies CompressionResult;
    options.bus.publish(ContextEvent.Compressed, { sessionId, result });
    return result;
  }

  async function compress(
    sessionId: string,
    force = false,
    modelId = "default",
  ): Promise<CompressionResult> {
    const historyBeforePrune =
      await options.messageManager.listBySession(sessionId);
    const fullTokens = tokenCount(
      options.tokenCounter,
      serializeHistory(historyBeforePrune),
    );
    const usage = getContextUsage(
      { estimatedTokens: fullTokens },
      modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    if (!force && !usage.shouldCompress) {
      return {
        status: "skipped",
        originalTokens: fullTokens,
        newTokens: fullTokens,
        savedTokens: 0,
      };
    }

    await prune(sessionId);
    return summarizeActiveHistory(sessionId);
  }

  function compactStatusFromCompression(
    compression: CompressionResult,
    pruneResult: PruneResult,
  ): CompactStatus {
    if (compression.status === "compressed") {
      return "compacted";
    }
    if (compression.status === "failed" || compression.status === "inflated") {
      return compression.status;
    }
    return pruneResult.prunedCount > 0 ? "pruned" : "not-needed";
  }

  async function compact(
    sessionId: string,
    input: CompactOptions,
  ): Promise<CompactResult> {
    const before = await assemble(
      sessionId,
      input.directory,
      input.isSubagent ?? false,
    );
    const usageBefore = getContextUsage(
      before,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    if (input.force !== true && !usageBefore.shouldCompress) {
      return {
        status: "not-needed",
        usageBefore,
        usageAfter: usageBefore,
      };
    }

    const pruneResult = await prune(sessionId);
    const afterPrune = await assemble(
      sessionId,
      input.directory,
      input.isSubagent ?? false,
    );
    const usageAfterPrune = getContextUsage(
      afterPrune,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    if (input.force !== true && !usageAfterPrune.shouldCompress) {
      return {
        status: pruneResult.prunedCount > 0 ? "pruned" : "not-needed",
        usageBefore,
        usageAfter: usageAfterPrune,
        prune: pruneResult,
      };
    }

    const compression = await summarizeActiveHistory(sessionId);
    const afterCompression = await assemble(
      sessionId,
      input.directory,
      input.isSubagent ?? false,
    );
    const usageAfter = getContextUsage(
      afterCompression,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    return {
      status: compactStatusFromCompression(compression, pruneResult),
      usageBefore,
      usageAfter,
      prune: pruneResult,
      compression,
      error: compression.error,
    };
  }

  return {
    assemble,
    getUsage(context: AssembledContext, modelId: string): ContextUsage {
      return getContextUsage(
        context,
        modelId,
        options.tokenCounter,
        compressionThreshold,
      );
    },
    shouldCompress(usage: ContextUsage): boolean {
      return usage.usageRatio >= compressionThreshold;
    },
    compress,
    compact,
    prune,
  };
}
