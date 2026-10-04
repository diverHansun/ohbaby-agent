import type { UiToolCall, UiToolResult } from "ohbaby-sdk";
import {
  sanitizeTerminalText,
  truncateAnsi,
  visibleWidth,
  wrapAnsi,
} from "../../../render/wrap.js";
import type { Theme } from "../../../theme/index.js";
import { renderToolLabelParts } from "./tool-part.js";

export interface ToolDisplayLine {
  readonly text: string;
  readonly color?: string;
  readonly dimColor?: boolean;
}

/** Tool facts become display rows here; this boundary never reads or executes. */
export function renderToolDisplay(
  call: UiToolCall,
  result: UiToolResult | undefined,
  width: number,
  expanded: boolean,
  theme: Theme,
): readonly ToolDisplayLine[] {
  width = Math.max(1, width);
  const label = renderToolLabelParts(call, result);
  const primary = primaryInput(call);
  const details = result?.details;
  const summary =
    details?.kind === "read" &&
    details.startLine !== undefined &&
    details.shownLineCount !== undefined
      ? details.shownLineCount === 0
        ? " · 0 lines"
        : ` · ${String(details.startLine)}–${String(details.startLine + details.shownLineCount - 1)}`
      : details?.kind === "search" && details.count !== undefined
        ? ` · ${String(details.count)} ${details.unit}${details.scanComplete === false ? " found" : ""}`
        : "";
  const title = `${label.name}${primary ? ` ${primary}` : ""}${summary}`;
  const titleRows = wrapAnsi(title, width);
  const titleBudget = call.name === "bash" ? 2 : 1;
  const rows: ToolDisplayLine[] = (
    expanded
      ? titleRows
      : call.name === "bash"
        ? limitTitle(titleRows, titleBudget, width)
        : [compactTitle(label.name, primary, summary, width)]
  ).map((text) => ({ text, color: theme.tool.arg }));
  const bodyWidth = Math.max(1, width - Math.min(2, Math.max(0, width - 1)));
  const indent = " ".repeat(width - bodyWidth);
  const body = (text: string, color?: string, dimColor?: boolean): void => {
    for (const line of wrapAnsi(safeText(text), bodyWidth))
      rows.push({ text: `${indent}${line}`, color, dimColor });
  };
  if (result?.error) body(`failed: ${result.error}`, theme.tool.failed);
  else if (label.error)
    body(
      label.error,
      (result?.execution ?? call.execution)?.phase === "awaiting-approval"
        ? theme.status.waiting
        : theme.tool.failed,
    );
  // Status results are machine receipts (IDs, scopes and execution arrays).
  // The existing Subagents browser owns these details, including under Ctrl+O.
  // Run/close results may contain failures without result.error: retain them.
  if (call.name === "subagent_status") return rows;
  if (details?.kind === "mutation" && details.dryRun)
    body("Dry run", theme.status.waiting);
  if (details?.kind === "bash" && details.jobId && details.status === "running")
    body(
      `Started in background${expanded ? ` · ${details.jobId}` : ""}`,
      theme.status.waiting,
    );
  if (
    details?.kind === "search" &&
    (details.scanComplete === false || details.displayLimited === true)
  ) {
    body(
      [
        details.scanComplete === false ? "Partial scan" : "",
        details.displayLimited === true ? "Output truncated" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      undefined,
      true,
    );
  }
  if (details?.kind === "read" && details.hasMore === true)
    body("Output truncated", undefined, true);
  if (
    details?.kind === "bash" &&
    (details.status === "timed_out" || details.status === "cancelled") &&
    !result?.error
  )
    body(
      details.status === "timed_out" ? "Timed out" : "Cancelled",
      theme.tool.failed,
    );
  if (!result) return rows;
  let content: ToolDisplayLine[] = [];
  if (
    details?.kind === "mutation" &&
    details.created === true &&
    !details.dryRun &&
    !result.error &&
    call.status === "completed" &&
    typeof call.input.content === "string"
  ) {
    content = wrapAnsi(safeText(call.input.content), bodyWidth).map((text) => ({
      text,
    }));
    content = preview(content, 10, expanded, false);
  } else if (details?.kind === "mutation" && details.diff !== undefined) {
    content = renderDiff(details.diff, bodyWidth, expanded, theme);
  } else if (
    !["read", "list", "glob", "grep", "web_search", "web_fetch"].includes(
      call.name,
    ) ||
    expanded
  ) {
    const redundantBackgroundReceipt =
      !expanded &&
      details?.kind === "bash" &&
      details.status === "running" &&
      details.jobId !== undefined &&
      result.output === "Command is still running with no output.";
    content =
      result.output === "" || redundantBackgroundReceipt
        ? []
        : wrapAnsi(safeText(result.output), bodyWidth).map((text) => ({
            text,
          }));
    content = preview(
      content,
      5,
      expanded,
      ["bash", "task_output"].includes(call.name),
    );
  }
  for (const line of content) {
    for (const wrapped of wrapAnsi(line.text, bodyWidth))
      rows.push({ ...line, text: `${indent}${wrapped}` });
  }
  if (details?.kind === "mutation" && details.diffOmissionReason)
    body(details.diffOmissionReason, undefined, true);
  if (
    details?.kind === "bash" &&
    details.exitCode !== undefined &&
    details.exitCode !== 0
  )
    body(`exit ${String(details.exitCode)}`, theme.tool.failed);
  if (details?.kind === "bash" && details.outputTruncated)
    body("Output truncated", undefined, true);
  if (result.outputAvailable === false && !result.error && content.length === 0)
    body("Output unavailable", undefined, true);
  return rows;
}

function preview(
  rows: ToolDisplayLine[],
  budget: number,
  expanded: boolean,
  tail: boolean,
): ToolDisplayLine[] {
  if (expanded || rows.length <= budget) return rows;
  const marker = {
    text: `… ${String(rows.length - budget)} ${rows.length - budget === 1 ? "line" : "lines"} omitted`,
    dimColor: true,
  };
  return tail
    ? [marker, ...rows.slice(-budget)]
    : [...rows.slice(0, budget), marker];
}

/** Keep the operation and saved facts, shortening the object by terminal columns. */
function compactTitle(
  name: string,
  primary: string,
  summary: string,
  width: number,
): string {
  // Compact summaries occupy one terminal row; expanded titles keep original input.
  primary = primary.replace(/[\r\n\t\u2028\u2029]+/gu, " ");
  const full = `${name}${primary ? ` ${primary}` : ""}${summary}`;
  if (visibleWidth(full) <= width) return full;
  const available = width - visibleWidth(name) - visibleWidth(summary) - 1;
  if (available < 1) return truncateAnsi(`${name}${summary}`, width);
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(primary),
    (item) => item.segment,
  );
  let head = "";
  let tail = "";
  const basename = primary.split(/[\\/]/u).at(-1) ?? primary;
  const headBudget = Math.max(
    0,
    Math.min(
      Math.floor((available - 1) / 3),
      available - 1 - visibleWidth(basename),
    ),
  );
  while (graphemes.length && visibleWidth(head + graphemes[0]) <= headBudget)
    head += graphemes.shift() ?? "";
  const tailBudget = available - visibleWidth(head) - 1;
  while (
    graphemes.length &&
    visibleWidth((graphemes.at(-1) ?? "") + tail) <= tailBudget
  )
    tail = (graphemes.pop() ?? "") + tail;
  return `${name} ${head}…${tail}${summary}`;
}

function limitTitle(rows: string[], budget: number, width: number): string[] {
  if (rows.length <= budget) return rows;
  return [
    ...rows.slice(0, budget - 1),
    truncateAnsi(`${rows[budget - 1]} …`, width),
  ];
}

function primaryInput(call: UiToolCall): string {
  if (call.name === "subagent_status") return "";
  const keys = call.name.startsWith("subagent_")
    ? ["name", "subagent_id"]
    : ["task_output", "task_kill"].includes(call.name)
      ? ["job_id"]
      : ["grep", "glob"].includes(call.name)
        ? ["pattern", "query", "path", "file_path"]
        : ["command", "file_path", "path", "pattern", "query"];
  const values = keys.flatMap((key) =>
    typeof call.input[key] === "string" && call.input[key] !== ""
      ? [safeText(call.input[key])]
      : [],
  );
  if (values.length > 0)
    return ["grep", "glob"].includes(call.name)
      ? values.join(" ")
      : (values[0] ?? "");
  if (call.name.startsWith("subagent_")) return "";
  return Object.entries(call.input)
    .filter(
      ([key, value]) =>
        !/prompt|instruction|metadata|token|secret|password/iu.test(key) &&
        ["string", "number", "boolean"].includes(typeof value),
    )
    .slice(0, 3)
    .map(([key, value]) => `${key}=${safeText(String(value))}`)
    .join(" ");
}

// Preserve SGR color, strip terminal commands and control bytes from tool data.
function safeText(text: string): string {
  return sanitizeTerminalText(text);
}

/** Parse saved unified diff, retaining hunk facts when expanded. */
export function renderDiff(
  diff: string,
  width: number,
  expanded: boolean,
  theme: Theme,
): ToolDisplayLine[] {
  const rows: ToolDisplayLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const numberWidth = Math.max(
    3,
    ...Array.from(
      safeText(diff).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu),
      (match) =>
        String(
          Math.max(
            Number(match[1]) + Number(match[2] || 1) - 1,
            Number(match[3]) + Number(match[4] || 1) - 1,
          ),
        ).length,
    ),
  );
  for (const raw of safeText(diff).split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (hunk) {
      const hasGap =
        inHunk && (Number(hunk[1]) > oldLine || Number(hunk[2]) > newLine);
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      if (expanded)
        rows.push(
          ...wrapAnsi(raw, width).map((text) => ({ text, dimColor: true })),
        );
      else if ((rows.length === 0 && newLine > 1) || hasGap)
        rows.push({ text: "…", dimColor: true });
      continue;
    }
    if (!inHunk) {
      if (expanded && raw !== "")
        rows.push(
          ...wrapAnsi(raw, width).map((text) => ({ text, dimColor: true })),
        );
      continue;
    }
    const sign = raw.charAt(0);
    if (![" ", "+", "-"].includes(sign)) {
      if (raw !== "")
        rows.push(
          ...wrapAnsi(raw, width).map((text) => ({ text, dimColor: true })),
        );
      continue;
    }
    const number = sign === "-" ? oldLine : newLine;
    if (sign !== "+") oldLine += 1;
    if (sign !== "-") newLine += 1;
    const prefix = `${sign} ${String(number).padStart(numberWidth)} `;
    const prefixWidth = Math.min(visibleWidth(prefix), Math.max(0, width - 1));
    const actualPrefix =
      visibleWidth(prefix) <= prefixWidth
        ? prefix
        : truncateAnsi(prefix, prefixWidth || 1);
    const prefixColumns = prefixWidth === 0 ? 0 : visibleWidth(actualPrefix);
    const lines = wrapAnsi(raw.slice(1), Math.max(1, width - prefixColumns));
    const color =
      sign === "+"
        ? theme.diff.add
        : sign === "-"
          ? theme.diff.remove
          : theme.tool.arg;
    lines.forEach((line, index) =>
      rows.push({
        text: `${index === 0 && prefixColumns ? actualPrefix : " ".repeat(prefixColumns)}${line}`,
        color,
      }),
    );
  }
  return preview(rows, 10, expanded, false);
}
