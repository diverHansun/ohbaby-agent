import type { UiContextWindowUsage } from "ohbaby-sdk";

export function formatContextWindowUsage(
  usage: UiContextWindowUsage | null | undefined,
): string {
  if (!usage || !Number.isFinite(usage.contextWindowTokens)) {
    return "";
  }
  if (usage.contextWindowTokens <= 0) {
    return "";
  }

  return `${formatTokenAmount(usage.currentTokens)} / ${formatTokenAmount(
    usage.contextWindowTokens,
  )} (${formatPercent(usage.contextWindowRatio)})`;
}

function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const normalized = Math.max(0, value);
  if (normalized >= 1_000_000) {
    return `${formatScaledNumber(normalized / 1_000_000)}M`;
  }
  if (normalized >= 1_000) {
    return `${formatScaledNumber(normalized / 1_000)}K`;
  }

  return String(Math.round(normalized));
}

function formatScaledNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return "0%";
  }
  if (ratio < 0.01) {
    return "<1%";
  }

  return `${String(Math.round(ratio * 100))}%`;
}
