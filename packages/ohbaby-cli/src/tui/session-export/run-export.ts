import type { CoreAPI } from "ohbaby-sdk";
import { resolveDownloadsDir } from "./downloads-dir.js";
import { saveExportFile } from "./save-export.js";

export type SessionExportFormat = "html" | "jsonl";

export const EXPORT_USAGE = "Usage: /export [html|jsonl]";

export function parseExportFormat(
  argv: readonly string[],
): SessionExportFormat | undefined {
  if (argv.length === 0) return "html";
  if (argv.length > 1) return undefined;
  const format = argv[0]?.toLowerCase();
  return format === "html" || format === "jsonl" ? format : undefined;
}

export interface SessionExportOutcome {
  readonly path: string;
  readonly messageCount: number;
}

export async function runSessionExport(input: {
  readonly client: Pick<CoreAPI, "exportSession">;
  readonly sessionId: string;
  readonly format: SessionExportFormat;
  readonly directory?: string;
  readonly save?: typeof saveExportFile;
}): Promise<SessionExportOutcome> {
  const result = await input.client.exportSession({
    sessionId: input.sessionId,
    format: input.format,
  });
  const path = await (input.save ?? saveExportFile)({
    directory: input.directory ?? resolveDownloadsDir(),
    filename: result.filename,
    content: result.content,
  });
  return { path, messageCount: result.messageCount };
}

/** Old backends surface a missing export as an unknown RPC method or missing storage. */
const UNSUPPORTED_PATTERN =
  /Unsupported daemon rpc method|is not a function|not available/i;

export function describeExportError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case "SESSION_NOT_FOUND":
      return "Session not found.";
    case "SUBAGENT_SESSION":
      return "Subagent sessions cannot be exported.";
    case "EMPTY_SESSION":
      return "Nothing to export in this session yet.";
    case "INVALID_FORMAT":
      return EXPORT_USAGE;
  }
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (
    (status === 404 && code === undefined) ||
    UNSUPPORTED_PATTERN.test(message)
  )
    return "Export is not supported by this backend.";
  return message;
}
