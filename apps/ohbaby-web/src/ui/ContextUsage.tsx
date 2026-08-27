import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import type {
  UiContextOccupancyComposition,
  UiContextWindowUsage,
} from "ohbaby-sdk";

type CompositionKey = keyof UiContextOccupancyComposition;

interface CompositionRow {
  readonly color: string;
  readonly key: CompositionKey;
  readonly label: string;
}

const COMPOSITION_ROWS: readonly CompositionRow[] = [
  { color: "#526d9d", key: "system-prompt", label: "System prompt" },
  { color: "#6b8ec8", key: "builtin-tools", label: "Built-in tools" },
  { color: "#7c73bd", key: "mcp", label: "MCP tools" },
  { color: "#a06cab", key: "skills", label: "Skills" },
  { color: "#cf7c92", key: "conversation", label: "Conversation" },
  {
    color: "#d89b6b",
    key: "summarized-conversation",
    label: "Summarized conversation",
  },
  {
    color: "#6fa399",
    key: "subagent-exchanges",
    label: "Subagent exchanges",
  },
];

export function ContextUsageControl(props: {
  readonly usage: UiContextWindowUsage | null;
}): ReactElement | null {
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const dialogId = useId();
  const usage = props.usage;
  const open = usage !== null && openSessionId === usage.sessionId;

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpenSessionId(null);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpenSessionId(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return (): void => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!usage) {
    return null;
  }

  const percent = usagePercent(usage);
  const circumference = 2 * Math.PI * 6;
  const progress = clamp01(usage.contextWindowRatio) * circumference;
  const ariaLabel = `${String(percent)}% context used, approximately ${formatTokens(
    usage.currentTokens,
  )} of ${formatTokens(usage.contextWindowTokens)} tokens`;

  return (
    <div
      className={`ohb-context-usage-control${open ? " is-open" : ""}`}
      ref={rootRef}
    >
      <button
        aria-controls={open ? dialogId : undefined}
        aria-describedby={open ? undefined : tooltipId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        className="ohb-context-ring-button"
        onClick={() => {
          setOpenSessionId((current) =>
            current === usage.sessionId ? null : usage.sessionId,
          );
        }}
        type="button"
      >
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
          <circle className="ohb-context-ring-track" cx="8" cy="8" r="6" />
          <circle
            className="ohb-context-ring-progress"
            cx="8"
            cy="8"
            r="6"
            strokeDasharray={`${String(progress)} ${String(circumference)}`}
          />
        </svg>
      </button>
      {!open ? (
        <div className="ohb-context-tooltip" id={tooltipId} role="tooltip">
          <strong>{percent}% context used</strong>
          <span>
            ~{formatTokens(usage.currentTokens)} /{" "}
            {formatTokens(usage.contextWindowTokens)} tokens
          </span>
        </div>
      ) : null}
      {open ? (
        <div
          aria-label="Context Usage"
          className="ohb-context-popover"
          id={dialogId}
          role="dialog"
        >
          <div className="ohb-context-popover-header">
            <h2>Context Usage</h2>
            <button
              aria-label="Close context usage"
              onClick={() => {
                setOpenSessionId(null);
              }}
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </button>
          </div>
          <ContextUsageDetails usage={usage} />
        </div>
      ) : null}
    </div>
  );
}

export function ContextUsageDetails(props: {
  readonly usage: UiContextWindowUsage;
}): ReactElement {
  const usage = props.usage;
  const composition = usage.composition;
  const usedWidth = clamp01(usage.contextWindowRatio) * 100;

  return (
    <div className="ohb-context-details">
      <div className="ohb-context-summary">
        <strong>{usagePercent(usage)}% Full</strong>
        <span>
          ~{formatTokens(usage.currentTokens)} /{" "}
          {formatTokens(usage.contextWindowTokens)}
        </span>
      </div>
      {composition ? (
        <>
          <div
            aria-label="Estimated context composition"
            className="ohb-context-stack"
          >
            <span
              className="ohb-context-stack-used"
              style={{ width: `${String(usedWidth)}%` }}
            >
              {COMPOSITION_ROWS.flatMap((row) => {
                const tokens = composition[row.key];
                if (tokens === 0) {
                  return [];
                }
                return [
                  <span
                    aria-hidden="true"
                    className="ohb-context-stack-segment"
                    key={row.key}
                    style={
                      {
                        "--ohb-context-segment-color": row.color,
                        flexGrow: tokens,
                      } as CSSProperties
                    }
                  />,
                ];
              })}
            </span>
          </div>
          <div className="ohb-context-composition">
            {COMPOSITION_ROWS.map((row) => (
              <div className="ohb-context-composition-row" key={row.key}>
                <span
                  aria-hidden="true"
                  className="ohb-context-composition-dot"
                  style={{ backgroundColor: row.color }}
                />
                <span>{row.label}</span>
                <span>~{formatTokens(composition[row.key])}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function usagePercent(usage: UiContextWindowUsage): number {
  return Math.round(clamp01(usage.contextWindowRatio) * 100);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${String(Math.round(value / 100_000) / 10)}M`;
  }
  if (value >= 1_000) {
    return `${String(Math.round(value / 100) / 10)}K`;
  }
  return String(Math.round(value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
