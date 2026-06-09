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
    label === ""
    ? "model connected"
    : `model connected: ${label}${context}`;
  const warning = result ? getString(result, "warning") : undefined;
  return warning === undefined ? connected : `${connected}\nwarning: ${warning}`;
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

  return {
    handle(event: UiEvent): void {
      if (event.type === "message.part.delta") {
        write(event.delta);
        return;
      }

      if (event.type === "command.result.delivered" && event.output) {
        write(`${renderOutput(event.output)}\n`);
        return;
      }

      if (event.type === "command.failed") {
        writeError(`${event.error.code}: ${event.error.message}\n`);
        return;
      }

      if (event.type === "runtime.updated" && event.status.kind === "error") {
        writeError(`error: ${event.status.message}\n`);
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
