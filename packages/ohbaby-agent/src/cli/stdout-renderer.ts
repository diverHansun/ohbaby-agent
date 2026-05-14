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
  return JSON.stringify(output.data);
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
      }
    },
  };
}
