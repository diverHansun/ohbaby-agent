import type { ToolExecutionContext } from "../../core/tool-scheduler/index.js";

interface ReadFileState {
  readonly mtimeMs: number;
}

const MAX_READ_FILE_STATES = 10_000;
const readFileStates = new Map<string, ReadFileState>();

function keyFor(context: ToolExecutionContext, resolvedPath: string): string {
  return `${context.sessionId}\0${resolvedPath}`;
}

export function recordTextFileRead(input: {
  readonly context: ToolExecutionContext;
  readonly mtimeMs: number;
  readonly resolvedPath: string;
}): void {
  while (readFileStates.size >= MAX_READ_FILE_STATES) {
    const oldest = readFileStates.keys().next();
    if (oldest.done === true) {
      break;
    }
    readFileStates.delete(oldest.value);
  }
  readFileStates.set(keyFor(input.context, input.resolvedPath), {
    mtimeMs: input.mtimeMs,
  });
}

export function assertTextFileWasReadBeforeEdit(input: {
  readonly actualMtimeMs: number;
  readonly context: ToolExecutionContext;
  readonly inputPath: string;
  readonly resolvedPath: string;
}): void {
  const state = readFileStates.get(keyFor(input.context, input.resolvedPath));
  if (!state) {
    throw new Error(
      `File must be read before edit: ${input.inputPath}. Call read first and pass its mtimeMs as expected_mtime_ms.`,
    );
  }
  if (state.mtimeMs !== input.actualMtimeMs) {
    throw new Error(
      `File must be read again before edit: ${input.inputPath}. The file changed since the last read.`,
    );
  }
}
