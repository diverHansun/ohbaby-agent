import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import type { UiMessagePart, UiToolCall, UiToolResult } from "ohbaby-sdk";

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
  const [open, setOpen] = useState(false);
  const failed =
    props.call.status === "failed" || props.result?.error !== undefined;

  return (
    <ToolPanel
      accent={failed ? "red" : toolAccent(props.call.name)}
      input={JSON.stringify(props.call.input, null, 2)}
      onToggle={() => {
        setOpen((value) => !value);
      }}
      open={open}
      output={props.result === undefined ? undefined : resultBody(props.result)}
      summary={toolSummary(props.call.input)}
      title={props.call.name}
    />
  );
}

export function OrphanToolResultCard(props: {
  readonly result: UiToolResult;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <ToolPanel
      accent={props.result.error === undefined ? "green" : "red"}
      onToggle={() => {
        setOpen((value) => !value);
      }}
      open={open}
      output={resultBody(props.result)}
      summary="result"
      title="tool result"
    />
  );
}

function ToolPanel(props: {
  readonly accent: "blue" | "gold" | "green" | "red";
  readonly input?: string;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly output?: string;
  readonly summary: string;
  readonly title: string;
}): ReactElement {
  return (
    <div className={`ohb-tool-panel ohb-tool-${props.accent}`}>
      <button aria-expanded={props.open} onClick={props.onToggle} type="button">
        <span>{props.title}</span>
        <span className="ohb-tool-summary">{props.summary}</span>
        <ChevronRight
          aria-hidden="true"
          className={`ohb-tool-chevron ${props.open ? "ohb-chevron-open" : ""}`}
          size={14}
        />
      </button>
      {props.open &&
      (props.input !== undefined || props.output !== undefined) ? (
        <div className="ohb-tool-details">
          {props.input !== undefined ? (
            <section className="ohb-tool-input">
              <span>Input</span>
              <pre>{props.input}</pre>
            </section>
          ) : null}
          {props.output !== undefined ? (
            <section className="ohb-tool-output">
              <span>Output</span>
              <pre>{props.output}</pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function resultBody(result: UiToolResult): string {
  const output = result.output.trim();
  const error = result.error?.trim() ?? "";
  if (output === "") {
    return error;
  }
  if (error === "" || output.includes(error)) {
    return result.output;
  }
  return `${result.output}\n\nError: ${error}`;
}

function toolAccent(name: string): "blue" | "gold" | "green" {
  const lowered = name.toLowerCase();
  if (lowered.includes("read")) {
    return "gold";
  }
  if (lowered.includes("edit") || lowered.includes("write")) {
    return "green";
  }
  return "blue";
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
