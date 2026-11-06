import { Check, CircleAlert, Copy } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { writeClipboard } from "./clipboard.js";
import { IconButton } from "./IconButton.js";

type CopyState = "idle" | "copied" | "failed";

interface CopyResult {
  readonly state: CopyState;
  /** A fresh object per click, so a repeat click restarts the reset timer. */
  readonly at: number;
}

/**
 * An icon button that copies quietly, like Claude's and Codex's message
 * actions: the icon turns into a check for a moment. A failed copy says so
 * instead of pretending it worked.
 */
export function CopyButton(props: {
  /** Text, or a function read at click time for content that may change. */
  readonly text: string | (() => string);
  /** Accessible name and tooltip while idle, e.g. "Copy message". */
  readonly label: string;
  readonly copiedLabel?: string;
  readonly className?: string;
}): ReactElement {
  const [result, setResult] = useState<CopyResult>({ state: "idle", at: 0 });
  const { state } = result;
  useEffect(() => {
    if (result.state === "idle") return;
    const timer = setTimeout(() => {
      setResult({ state: "idle", at: Date.now() });
    }, 1500);
    return (): void => {
      clearTimeout(timer);
    };
  }, [result]);
  const label =
    state === "copied"
      ? (props.copiedLabel ?? "Copied")
      : state === "failed"
        ? "Copy failed"
        : props.label;
  return (
    <IconButton
      label={label}
      className={props.className}
      data-copy-state={state}
      onClick={() => {
        const text =
          typeof props.text === "function" ? props.text() : props.text;
        void writeClipboard(text).then((copied) => {
          setResult({ state: copied ? "copied" : "failed", at: Date.now() });
        });
      }}
    >
      {state === "copied" ? (
        <Check aria-hidden="true" size={14} />
      ) : state === "failed" ? (
        <CircleAlert aria-hidden="true" size={14} />
      ) : (
        <Copy aria-hidden="true" size={14} />
      )}
    </IconButton>
  );
}
