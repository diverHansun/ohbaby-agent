import type { UiCommandOutput, UiEvent } from "ohbaby-sdk";

export interface StdoutRendererOptions {
  readonly write?: (chunk: string) => void;
  readonly writeError?: (chunk: string) => void;
}

export interface StdoutRenderer {
  handle(event: UiEvent): void;
}

function renderOutput(output: UiCommandOutput): string {
  if (output.kind === "text") {
    return output.text;
  }
  if (output.kind === "markdown") {
    return output.markdown;
  }
  if (output.subject === "model.connected") {
    return formatModelConnectedOutput(output.data);
  }
  return JSON.stringify(output.data);
}

function formatModelConnectedOutput(data: Record<string, unknown>): string {
  const result = getRecord(data, "result");
  const model = result ? getString(result, "model") : undefined;
  const provider = result ? getString(result, "provider") : undefined;
  const contextWindowTokens = result
    ? getNumber(result, "contextWindowTokens")
    : undefined;
  const label = [provider, model].filter(Boolean).join("/");
  const context =
    contextWindowTokens === undefined
      ? ""
      : ` (${formatTokenCount(contextWindowTokens)} context tokens)`;
  const connected =
    label === "" ? "model connected" : `model connected: ${label}${context}`;
  const warning = result ? getString(result, "warning") : undefined;
  return warning === undefined
    ? connected
    : `${connected}\nwarning: ${warning}`;
}

function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createStdoutRenderer(
  options: StdoutRendererOptions = {},
): StdoutRenderer {
  const write =
    options.write ??
    ((chunk: string): void => {
      process.stdout.write(chunk);
    });
  const writeError =
    options.writeError ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });

  const emittedTextByPart = new Map<string, string>();
  const sourceMessageIds = new Set<string>();
  const sourceTextParts = new Map<string, ReadonlySet<string>>();
  const messageKey = (sessionId: string, messageId: string): string =>
    JSON.stringify([sessionId, messageId]);
  const partKey = (
    sessionId: string,
    messageId: string,
    partId: string | number,
  ): string => JSON.stringify([sessionId, messageId, partId]);

  function writeCumulativeText(key: string, text: string): void {
    const emitted = emittedTextByPart.get(key) ?? "";
    // stdout cannot retract earlier bytes. Duplicate, stale or rewritten prefixes
    // must not replay them; only a cumulative extension adds output.
    if (!text.startsWith(emitted)) return;
    const delta = text.slice(emitted.length);
    emittedTextByPart.set(key, text);
    if (delta.length > 0) write(delta);
  }

  return {
    handle(event: UiEvent): void {
      if (event.type === "session.changed") {
        for (const message of event.messages ?? []) {
          if (message.role !== "assistant") continue;
          const sourceKey = messageKey(event.version.sessionId, message.id);
          sourceMessageIds.add(sourceKey);
          sourceTextParts.set(
            sourceKey,
            new Set(
              message.parts.flatMap((part) =>
                part.type === "text" && part.id !== undefined ? [part.id] : [],
              ),
            ),
          );
          message.parts.forEach((part, index) => {
            if (part.type === "text") {
              writeCumulativeText(
                partKey(event.version.sessionId, message.id, part.id ?? index),
                part.text,
              );
            }
          });
        }
        for (const id of event.removedMessageIds ?? [])
          sourceTextParts.delete(messageKey(event.version.sessionId, id));
        for (const append of event.textAppends ?? []) {
          if (
            !sourceTextParts
              .get(messageKey(event.version.sessionId, append.messageId))
              ?.has(append.partId)
          )
            continue;
          const key = partKey(
            event.version.sessionId,
            append.messageId,
            append.partId,
          );
          const emitted = emittedTextByPart.get(key);
          // Offsets are UTF-16 String.length, exactly matching the source contract.
          // Unknown, missing or replayed ranges cannot safely add bytes to stdout.
          if (
            emitted === undefined ||
            !Number.isSafeInteger(append.offset) ||
            append.offset !== emitted.length
          )
            continue;
          writeCumulativeText(key, emitted + append.text);
        }
        return;
      }

      if (event.type === "message.part.delta") {
        if (
          event.messageId !== undefined &&
          sourceMessageIds.has(messageKey(event.sessionId, event.messageId))
        )
          return;
        if (event.messageId !== undefined && event.partId !== undefined) {
          const key = partKey(event.sessionId, event.messageId, event.partId);
          writeCumulativeText(
            key,
            event.content ??
              `${emittedTextByPart.get(key) ?? ""}${event.delta}`,
          );
        } else {
          write(event.delta);
        }
        return;
      }

      if (event.type === "command.result.delivered" && event.output) {
        write(`${renderOutput(event.output)}\n`);
        return;
      }

      if (event.type === "command.failed") {
        writeError(`[${event.error.code}] ${event.error.message}\n`);
        return;
      }

      if (event.type === "runtime.updated" && event.status.kind === "error") {
        writeError(
          event.status.code === undefined
            ? `error: ${event.status.message}\n`
            : `[${event.status.code}] ${event.status.message}\n`,
        );
        return;
      }

      if (
        event.type === "notice.emitted" &&
        (event.notice.level === "warning" || event.notice.level === "error")
      ) {
        const source =
          event.notice.source === undefined ? "" : ` (${event.notice.source})`;
        writeError(
          `${event.notice.level}: ${event.notice.title}: ${event.notice.message}${source}\n`,
        );
      }
    },
  };
}
