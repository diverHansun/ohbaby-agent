import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiPermissionRequest,
  UiPermissionResponseContext,
} from "ohbaby-sdk";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTheme } from "../theme/index.js";
import { useTuiLayout } from "../layout/context.js";
import { visibleWidth, wrapAnsi } from "../render/wrap.js";

export interface PermissionDialogProps {
  readonly client: CoreAPI;
  readonly request: UiPermissionRequest;
  readonly ready: boolean;
  readonly context?: UiPermissionResponseContext;
  readonly onResync: () => void;
  readonly maxHeight?: number;
  readonly controllableRun?: boolean;
  readonly syncError?: string;
  readonly retryHint?: string;
}

/** Fixed chrome and a shared reading window keep every original description reachable. */
export function PermissionDialog({
  client,
  request: original,
  ready,
  context,
  onResync,
  maxHeight = 18,
  controllableRun = false,
  syncError,
  retryHint,
}: PermissionDialogProps): ReactElement {
  const theme = useTheme();
  const layout = useTuiLayout();
  const width = Math.max(1, layout.contentWidth);
  const request = {
    ...original,
    choices: original.choices.filter(
      (c) => c.id !== "cancel" && c.intent !== "abort",
    ),
  };
  const initial = (): string | undefined =>
    (
      request.choices.find((c) => c.intent === "allow") ??
      request.choices.find((c) => c.intent === "deny") ??
      request.choices.at(0)
    )?.id;
  const identity = JSON.stringify([
    request.id,
    request.rootSessionId,
    context?.permissionEpoch,
    context?.rootSessionId,
    context?.bindingGeneration,
  ]);
  const scope = useRef({ identity });
  if (scope.current.identity !== identity) scope.current = { identity };
  const mounted = useRef(true);
  const [selected, setSelected] = useState(initial);
  const selectedRef = useRef(selected);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    selectedRef.current = initial();
    setSelected(selectedRef.current);
    pendingRef.current = false;
    setPending(false);
    setError(null);
    setExpired(false);
    setOffset(0);
  }, [identity]);
  // Keep identity rather than position when the same request updates its choices.
  const selectedIndex = Math.max(
    0,
    request.choices.findIndex((c) => c.id === selected),
  );
  useLayoutEffect(() => {
    if (!request.choices.some((c) => c.id === selectedRef.current)) {
      selectedRef.current = initial();
      setSelected(selectedRef.current);
      setOffset(0);
    }
  }, [JSON.stringify(request.choices)]);
  const source =
    request.sessionId === request.rootSessionId
      ? "Main agent"
      : `Subagent: ${request.sourceLabel ?? request.sessionId}`;
  const label = (choice: UiPermissionRequest["choices"][number]): string =>
    choice.id === "allow_always"
      ? `Allow matching requests in ${request.sessionId === request.rootSessionId ? "this session" : "this subagent session"}`
      : choice.label;
  const titleLine = `Permission: ${request.title}`;
  const sourceLine = `From: ${source}`;
  const fullChrome = [titleLine, sourceLine].filter(
    (line) => summary(line, width) !== line,
  );
  const heading = wrapAnsi(request.description, width);
  const starts: number[] = [];
  const body = [...heading];
  for (const choice of request.choices) {
    const choiceStart = body.length;
    // Only overflow needs a second reading surface. Ordinary options belong
    // exclusively to the actionable list below the operation.
    const choiceLabel = label(choice);
    if (summary(`> ${choiceLabel}`, width) !== `> ${choiceLabel}`)
      body.push(...wrapAnsi(choiceLabel, width));
    if (choice.label !== choiceLabel && choice.label !== "Always allow")
      body.push(...wrapAnsi(choice.label, width));
    starts.push(body.length > choiceStart ? choiceStart : 0);
  }
  for (const line of fullChrome) body.push(...wrapAnsi(line, width));
  const errorStart = body.length;
  const errorText =
    error || syncError ? `Error: ${error ?? syncError ?? ""}` : "";
  if (errorText && (expired || summary(errorText, width) !== errorText))
    body.push(...wrapAnsi(errorText, width));
  const deny = request.choices.find((c) => c.intent === "deny");
  const available =
    ready && !!context && !expired && request.choices.length > 0;
  const hintText = (overflow: boolean): string =>
    [
      available && !pending
        ? `↑↓ choose · Enter confirm${deny ? " · Esc reject" : ""}`
        : "",
      overflow ? "PgUp/PgDn read" : "",
      controllableRun ? "Ctrl+C stop" : "",
      retryHint,
    ]
      .filter(Boolean)
      .join(" · ");
  const choiceRows = Math.min(3, request.choices.length);
  const baseHints = wrapAnsi(hintText(false), width);
  const overflow =
    body.length > Math.max(1, maxHeight - 3 - choiceRows - baseHints.length);
  const hints = overflow ? wrapAnsi(hintText(true), width) : baseHints;
  const readingRows = Math.max(1, maxHeight - 3 - choiceRows - hints.length);
  const tooSmall = maxHeight < 3 + choiceRows + hints.length + 1;
  const start = Math.max(0, Math.min(offset, body.length - readingRows));
  const choiceStart = Math.max(
    0,
    Math.min(
      selectedIndex - choiceRows + 1,
      request.choices.length - choiceRows,
    ),
  );
  useInput((_, key) => {
    if (key.shift && (key.pageUp || key.pageDown || key.home || key.end))
      return;
    if (key.pageUp || key.pageDown) {
      setOffset(
        Math.max(
          0,
          Math.min(
            body.length - readingRows,
            start + (key.pageUp ? -readingRows : readingRows),
          ),
        ),
      );
      return;
    }
    if (!mounted.current || pendingRef.current || !available || tooSmall)
      return;
    if (
      key.upArrow ||
      key.leftArrow ||
      key.downArrow ||
      key.rightArrow ||
      key.tab
    ) {
      const delta = key.upArrow || key.leftArrow ? -1 : 1;
      const index =
        (selectedIndex + delta + request.choices.length) %
        request.choices.length;
      selectedRef.current = request.choices[index].id;
      setSelected(selectedRef.current);
      setOffset(starts[index]);
      return;
    }
    if (!key.return && !key.escape) return;
    const choice = key.escape
      ? deny
      : request.choices.find((c) => c.id === selectedRef.current);
    if (!choice) {
      if (key.escape) {
        const message = "No reject option. Choose an option explicitly.";
        setError(message);
        if (summary(`Error: ${message}`, width) !== `Error: ${message}`)
          setOffset(body.length);
      }
      return;
    }
    const currentScope = scope.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    void client
      .respondPermission(request.id, { choiceId: choice.id }, context)
      .catch((caught: unknown) => {
        if (!mounted.current || scope.current !== currentScope) return;
        const message =
          caught instanceof Error
            ? caught.message
            : "Permission response failed";
        setError(message);
        pendingRef.current = false;
        setPending(false);
        if (summary(`Error: ${message}`, width) !== `Error: ${message}`)
          setOffset(body.length);
        if (
          typeof caught === "object" &&
          caught !== null &&
          "code" in caught &&
          caught.code === "PERMISSION_NOT_PENDING"
        ) {
          setExpired(true);
          setOffset(body.length);
          onResync();
        }
      });
  });
  if (tooSmall)
    return (
      <Box flexDirection="column">
        {wrapAnsi("Resize terminal to review this request", width)
          .slice(0, Math.max(0, maxHeight))
          .map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
      </Box>
    );
  const visibleError = error ?? syncError;
  const status = visibleError
    ? expired
      ? "Synchronizing approvals..."
      : `Error: ${visibleError}`
    : pending
      ? "sending..."
      : !ready || !context || expired
        ? "Synchronizing approvals..."
        : request.choices.length === 0
          ? "No choices; cannot respond"
          : "";
  const range = `${String(start + 1)}–${String(Math.min(body.length, start + readingRows))}/${String(body.length)}`;
  return (
    <Box flexDirection="column">
      <Text color={theme.status.warning}>{summary(titleLine, width)}</Text>
      <Text>{summary(sourceLine, width)}</Text>
      {body.slice(start, start + readingRows).map((line, i) => (
        <Text
          key={i}
          color={start + i >= errorStart ? theme.status.error : undefined}
        >
          {line || " "}
        </Text>
      ))}
      {status || overflow ? (
        <Text
          dimColor={!visibleError}
          color={visibleError ? theme.status.error : undefined}
        >
          {summary(
            [status, overflow && !visibleError ? range : ""]
              .filter(Boolean)
              .join(" · "),
            width,
          )}
        </Text>
      ) : null}
      {request.choices
        .slice(choiceStart, choiceStart + choiceRows)
        .map((choice) => (
          <Text
            key={choice.id}
            bold={choice.id === selected}
            color={choice.id === selected ? theme.status.accent : undefined}
          >
            {summary(
              `${choice.id === selected ? ">" : " "} ${label(choice)}`,
              width,
            )}
          </Text>
        ))}
      {hints.map((line, i) => (
        <Text dimColor key={i}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
function summary(text: string, width: number): string {
  const plain = text.replace(/[\r\n\t]/gu, " ");
  if (visibleWidth(plain) <= width) return plain;
  const chars = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(plain),
    (item) => item.segment,
  );
  let front = "",
    back = "";
  while (chars.length) {
    const a = chars.shift() ?? "";
    if (visibleWidth(front + a + "…" + back) > width) break;
    front += a;
    if (!chars.length) break;
    const b = chars.pop() ?? "";
    if (visibleWidth(front + "…" + b + back) > width) break;
    back = b + back;
  }
  return front + "…" + back;
}
