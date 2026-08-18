import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { UiMessagePart, UiToolCall, UiToolResult } from "ohbaby-sdk";

const SHORT_FAILURE_MAX_CHARACTERS = 400;
const SHORT_FAILURE_MAX_LINES = 8;

export type PairedToolPart =
  | {
      readonly kind: "part";
      readonly part: UiMessagePart;
      readonly sourceIndex: number;
    }
  | {
      readonly call: UiToolCall;
      readonly kind: "tool";
      readonly result: UiToolResult | undefined;
      readonly sourceIndex: number;
    }
  | {
      readonly kind: "orphan-result";
      readonly result: UiToolResult;
      readonly sourceIndex: number;
    };

export function pairToolParts(
  parts: readonly UiMessagePart[],
): readonly PairedToolPart[] {
  const calls = new Set(
    parts.flatMap((part) => (part.type === "tool-call" ? [part.call.id] : [])),
  );
  const resultByCallId = new Map<string, UiToolResult>();
  for (const part of parts) {
    if (
      part.type === "tool-result" &&
      !resultByCallId.has(part.result.callId)
    ) {
      resultByCallId.set(part.result.callId, part.result);
    }
  }

  return parts.flatMap((part, sourceIndex): PairedToolPart[] => {
    if (part.type === "tool-call") {
      return [
        {
          call: part.call,
          kind: "tool",
          result: resultByCallId.get(part.call.id),
          sourceIndex,
        },
      ];
    }
    if (part.type === "tool-result") {
      return calls.has(part.result.callId)
        ? []
        : [{ kind: "orphan-result", result: part.result, sourceIndex }];
    }
    return [{ kind: "part", part, sourceIndex }];
  });
}

export function ToolCard(props: {
  readonly call: UiToolCall;
  readonly result: UiToolResult | undefined;
}): ReactElement {
  const failed =
    props.call.status === "failed" || props.result?.error !== undefined;
  const status = failed ? "failed" : props.call.status;
  const body = toolBody(props.call, props.result);
  const shortFailure = failed && isShortBody(body);
  const [open, setOpen] = useState(shortFailure);
  const wasFailed = useRef(failed);

  useEffect(() => {
    if (!wasFailed.current && failed && shortFailure) {
      setOpen(true);
    }
    wasFailed.current = failed;
  }, [failed, shortFailure]);

  return (
    <ToolPanel
      accent={failed ? "red" : toolAccent(props.call.name)}
      body={body}
      meta={status}
      onToggle={() => {
        setOpen((value) => !value);
      }}
      open={open}
      summary={toolSummary(props.call.input)}
      title={props.call.name}
    />
  );
}

export function OrphanToolResultCard(props: {
  readonly result: UiToolResult;
}): ReactElement {
  const failed = props.result.error !== undefined;
  const body = resultBody(props.result);
  const [open, setOpen] = useState(failed && isShortBody(body));
  return (
    <ToolPanel
      accent={failed ? "red" : "green"}
      body={body}
      meta={failed ? "failed" : "completed"}
      onToggle={() => {
        setOpen((value) => !value);
      }}
      open={open}
      summary={props.result.error ?? "result"}
      title="tool result"
    />
  );
}

function ToolPanel(props: {
  readonly accent: "blue" | "gold" | "green" | "red";
  readonly body: string;
  readonly meta: string;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly summary: string;
  readonly title: string;
}): ReactElement {
  return (
    <div className={`ohb-tool-panel ohb-tool-${props.accent}`}>
      <button aria-expanded={props.open} onClick={props.onToggle} type="button">
        <span>{props.title}</span>
        <span className="ohb-tool-summary">{props.summary}</span>
        <span className="ohb-tool-meta">{props.meta}</span>
        <ChevronDown
          className={props.open ? "ohb-chevron-open" : ""}
          size={16}
        />
      </button>
      {props.open && props.body !== "" ? <pre>{props.body}</pre> : null}
    </div>
  );
}

function toolBody(call: UiToolCall, result: UiToolResult | undefined): string {
  return result === undefined
    ? JSON.stringify(call.input, null, 2)
    : resultBody(result);
}

function resultBody(result: UiToolResult): string {
  return result.output.trim() !== "" ? result.output : (result.error ?? "");
}

function toolSummary(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "query", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return truncate(value.replaceAll(/\s+/g, " ").trim(), 120);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return truncate(`${key}: ${rendered}`, 120);
  }
  return "";
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function isShortBody(body: string): boolean {
  return (
    body.length <= SHORT_FAILURE_MAX_CHARACTERS &&
    body.split("\n").length <= SHORT_FAILURE_MAX_LINES
  );
}

function toolAccent(name: string): "blue" | "gold" | "green" | "red" {
  const lowered = name.toLowerCase();
  if (lowered.includes("read")) {
    return "gold";
  }
  if (lowered.includes("edit") || lowered.includes("write")) {
    return "green";
  }
  return "blue";
}
