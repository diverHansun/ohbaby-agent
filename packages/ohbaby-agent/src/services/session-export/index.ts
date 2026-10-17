import { collectExportDocument } from "./collect.js";
import { SessionExportError } from "./errors.js";
import { renderHtml } from "./html/render.js";
import { renderJsonl } from "./jsonl.js";
import type { ExportDependencies, ExportInput, ExportResult } from "./types.js";

export { SessionExportError } from "./errors.js";
export type { ExportDependencies, ExportInput, ExportResult } from "./types.js";

function validateInput(input: unknown): asserts input is ExportInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SessionExportError(
      "INVALID_ARGUMENT",
      "Export input must be an object",
    );
  }
  const value = input as Record<string, unknown>;
  if (value.format !== "html" && value.format !== "jsonl") {
    throw new SessionExportError(
      "INVALID_FORMAT",
      "Export format must be html or jsonl",
    );
  }
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.trim().length === 0
  ) {
    throw new SessionExportError("INVALID_ARGUMENT", "Session ID is required");
  }
}

export async function exportSession(
  deps: ExportDependencies,
  input: ExportInput,
): Promise<ExportResult> {
  validateInput(input);
  const now = deps.now?.() ?? new Date();
  const document = await collectExportDocument(deps, input.sessionId, now);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const id = document.header.session.id;
  const suffix =
    (id.includes("_")
      ? id.slice(id.lastIndexOf("_") + 1)
      : id.slice(-8)
    ).replace(/[^A-Za-z0-9-]/g, "") || "session";
  return {
    filename: `ohbaby-${date}-${time}-${suffix}.${input.format}`,
    mimeType:
      input.format === "html"
        ? "text/html; charset=utf-8"
        : "application/x-ndjson; charset=utf-8",
    content:
      input.format === "html" ? renderHtml(document) : renderJsonl(document),
    messageCount: document.header.stats.messageCount,
  };
}
