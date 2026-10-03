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

/** Compact footer view; status-panel details keep their existing format. */
export function formatFooterContextUsage(
  usage: UiContextWindowUsage | null | undefined,
): string {
  if (
    !usage ||
    !Number.isFinite(usage.contextWindowTokens) ||
    usage.contextWindowTokens <= 0 ||
    !Number.isFinite(usage.currentTokens) ||
    usage.currentTokens < 0 ||
    !Number.isFinite(usage.contextWindowRatio) ||
    usage.contextWindowRatio < 0
  )
    return "—";
  const percent = usage.contextWindowRatio * 100;
  const label =
    percent === 0
      ? "0%"
      : percent < 0.1
        ? "<0.1%"
        : percent < 1
          ? `${formatScaledNumber(percent)}%`
          : `${String(Math.round(percent))}%`;
  return `${label} ${formatTokenAmount(usage.currentTokens).toLowerCase()}/${formatTokenAmount(usage.contextWindowTokens).toLowerCase()}`;
}
