import {
  MASK_EXEMPT_TOOL_PREFIXES,
  MASK_MIN_PART_TOKENS,
  MASK_MIN_PRUNABLE_TOKENS,
  MASK_MIN_USAGE_RATIO,
  MASK_PLACEHOLDER_PREFIX,
  MASK_PROTECTION_TOKENS,
} from "./constants.js";
import { serializeMessage } from "./serialization.js";
import type { ContextUsage, TokenCounter } from "./types.js";
import type { MessageWithParts, ToolPart } from "../message/index.js";

export type MaskSkippedReason =
  | "below-threshold"
  | "below-batch"
  | "all-exempt";

export interface MaskConfig {
  readonly enabled: boolean;
  readonly exemptToolPrefixes: readonly string[];
  readonly minPartTokens: number;
  readonly minPrunableTokens: number;
  readonly minUsageRatio: number;
  readonly placeholderPrefix: string;
  readonly protectionTokens: number;
}

export interface ContextMaskedEventPayload {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly maskedPartIds: readonly string[];
  readonly maskedTokens: number;
  readonly cutoff: number;
  readonly usageRatio: number;
  readonly skippedReason?: MaskSkippedReason;
}

export interface ModelReductionResult {
  readonly history: readonly MessageWithParts[];
  readonly event: ContextMaskedEventPayload;
  readonly cutoff: number;
}

export function createMaskConfig(
  input: {
    readonly enabled?: boolean;
    readonly exemptToolPrefixes?: readonly string[];
    readonly minPartTokens?: number;
    readonly minPrunableTokens?: number;
    readonly minUsageRatio?: number;
    readonly placeholderPrefix?: string;
    readonly protectionTokens?: number;
  } = {},
): MaskConfig {
  return {
    enabled: input.enabled ?? false,
    exemptToolPrefixes:
      input.exemptToolPrefixes ?? MASK_EXEMPT_TOOL_PREFIXES,
    minPartTokens: input.minPartTokens ?? MASK_MIN_PART_TOKENS,
    minPrunableTokens:
      input.minPrunableTokens ?? MASK_MIN_PRUNABLE_TOKENS,
    minUsageRatio: input.minUsageRatio ?? MASK_MIN_USAGE_RATIO,
    placeholderPrefix: input.placeholderPrefix ?? MASK_PLACEHOLDER_PREFIX,
    protectionTokens: input.protectionTokens ?? MASK_PROTECTION_TOKENS,
  };
}

export function reduceForModel(input: {
  readonly sessionId: string;
  readonly history: readonly MessageWithParts[];
  readonly usage: ContextUsage;
  readonly cutoff: number;
  readonly config: MaskConfig;
  readonly tokenCounter: Pick<TokenCounter, "estimateTokens">;
  readonly allowCutoffAdvance?: boolean;
}): ModelReductionResult {
  const allowCutoffAdvance = input.allowCutoffAdvance ?? true;
  const candidates = collectMaskCandidates({
    config: input.config,
    history: input.history,
    tokenCounter: input.tokenCounter,
  });
  const candidateTokens = candidates.reduce(
    (sum, candidate) => sum + candidate.tokens,
    0,
  );
  const highestCandidateCutoff = candidates.reduce(
    (highest, candidate) => Math.max(highest, candidate.createdAt),
    -1,
  );
  const skippedReason = skippedReasonForReduction({
    candidateCount: candidates.length,
    candidateTokens,
    config: input.config,
    usage: input.usage,
  });
  const shouldAdvance =
    allowCutoffAdvance &&
    skippedReason === undefined &&
    highestCandidateCutoff > 0;
  const cutoff = shouldAdvance
    ? Math.max(input.cutoff, highestCandidateCutoff)
    : input.cutoff;
  const selected = candidates.filter(
    (candidate) => candidate.createdAt <= cutoff,
  );
  const event = {
    sessionId: input.sessionId,
    enabled: input.config.enabled,
    maskedPartIds: selected.map((candidate) => candidate.part.id),
    maskedTokens: selected.reduce(
      (sum, candidate) => sum + candidate.tokens,
      0,
    ),
    cutoff,
    usageRatio: input.usage.usageRatio,
    ...(selected.length === 0 && skippedReason !== undefined
      ? { skippedReason }
      : {}),
  } satisfies ContextMaskedEventPayload;

  if (!input.config.enabled || selected.length === 0) {
    return { history: input.history, event, cutoff };
  }

  const selectedByPartId = new Map(
    selected.map((candidate) => [candidate.part.id, candidate.tokens] as const),
  );
  return {
    cutoff,
    event,
    history: input.history.map((message) => ({
      info: message.info,
      parts: message.parts.map((part) => {
        const tokens = selectedByPartId.get(part.id);
        if (tokens === undefined || part.type !== "tool") {
          return part;
        }
        return maskToolPart(part, tokens, input.config);
      }),
    })),
  };
}

interface MaskCandidate {
  readonly createdAt: number;
  readonly messageIndex: number;
  readonly part: ToolPart;
  readonly tokens: number;
}

function collectMaskCandidates(input: {
  readonly config: MaskConfig;
  readonly history: readonly MessageWithParts[];
  readonly tokenCounter: Pick<TokenCounter, "estimateTokens">;
}): readonly MaskCandidate[] {
  const protectedIndexes = protectedMessageIndexes(input);
  const candidates: MaskCandidate[] = [];

  input.history.forEach((message, messageIndex) => {
    if (protectedIndexes.has(messageIndex)) {
      return;
    }
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (isExemptTool(part.tool, input.config.exemptToolPrefixes)) {
        continue;
      }
      const content = toolResultContent(part);
      if (content === undefined || isMaskedContent(content, input.config)) {
        continue;
      }
      const tokens = Math.max(0, input.tokenCounter.estimateTokens(content));
      if (tokens < input.config.minPartTokens) {
        continue;
      }
      candidates.push({
        createdAt: message.info.time.created,
        messageIndex,
        part,
        tokens,
      });
    }
  });

  return candidates;
}

function protectedMessageIndexes(input: {
  readonly config: MaskConfig;
  readonly history: readonly MessageWithParts[];
  readonly tokenCounter: Pick<TokenCounter, "estimateTokens">;
}): ReadonlySet<number> {
  const protectedIndexes = new Set<number>();
  const latestUserIndex = findLatestUserIndex(input.history);
  if (latestUserIndex >= 0) {
    for (let index = latestUserIndex; index < input.history.length; index += 1) {
      protectedIndexes.add(index);
    }
  }

  let tailTokens = 0;
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    if (tailTokens >= input.config.protectionTokens) {
      break;
    }
    protectedIndexes.add(index);
    tailTokens += Math.max(
      0,
      input.tokenCounter.estimateTokens(serializeMessage(input.history[index])),
    );
  }

  return protectedIndexes;
}

function findLatestUserIndex(history: readonly MessageWithParts[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.info.role === "user") {
      return index;
    }
  }
  return -1;
}

function skippedReasonForReduction(input: {
  readonly candidateCount: number;
  readonly candidateTokens: number;
  readonly config: MaskConfig;
  readonly usage: ContextUsage;
}): MaskSkippedReason | undefined {
  if (input.usage.usageRatio < input.config.minUsageRatio) {
    return "below-threshold";
  }
  if (input.candidateCount === 0) {
    return "all-exempt";
  }
  if (input.candidateTokens < input.config.minPrunableTokens) {
    return "below-batch";
  }
  return undefined;
}

function isExemptTool(
  tool: string,
  exemptToolPrefixes: readonly string[],
): boolean {
  const normalized = tool.toLowerCase();
  return exemptToolPrefixes.some((prefix) =>
    normalized.startsWith(prefix.toLowerCase()),
  );
}

function toolResultContent(part: ToolPart): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "aborted":
      return part.state.output === undefined || part.state.output === ""
        ? undefined
        : part.state.output;
    case "pending":
    case "running":
      return undefined;
  }
}

function maskToolPart(
  part: ToolPart,
  tokens: number,
  config: MaskConfig,
): ToolPart {
  const placeholder = `${config.placeholderPrefix} (was ~${String(tokens)} tokens)]`;
  switch (part.state.status) {
    case "completed":
      return {
        ...part,
        state: { ...part.state, output: placeholder },
      };
    case "error":
      return {
        ...part,
        state: { ...part.state, error: placeholder },
      };
    case "aborted":
      return {
        ...part,
        state: { ...part.state, output: placeholder },
      };
    case "pending":
    case "running":
      return part;
  }
}

function isMaskedContent(content: string, config: MaskConfig): boolean {
  return content.startsWith(config.placeholderPrefix);
}
