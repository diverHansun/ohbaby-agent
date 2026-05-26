import type { MessageWithParts } from "../message/index.js";

export interface FileOpsExtract {
  readonly read: readonly string[];
  readonly modified: readonly string[];
}

const READ_TOOLS = new Set(["cat", "read", "read_file", "view"]);
const MODIFIED_TOOLS = new Set([
  "apply_patch",
  "edit",
  "edit_file",
  "str_replace",
  "write",
  "write_file",
]);

export function extractFileOps(
  history: readonly MessageWithParts[],
): FileOpsExtract {
  const read = new Set<string>();
  const modified = new Set<string>();

  for (const message of history) {
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue;
      }
      const path = pathFromInput(part.state.input);
      if (!path) {
        continue;
      }
      if (READ_TOOLS.has(part.tool)) {
        read.add(path);
      }
      if (MODIFIED_TOOLS.has(part.tool)) {
        modified.add(path);
      }
    }
  }

  return { read: [...read].sort(), modified: [...modified].sort() };
}

export function appendFileOpsSummary(
  summary: string,
  fileOps: FileOpsExtract,
): string {
  const blocks = [
    formatBlock("read-files", fileOps.read),
    formatBlock("modified-files", fileOps.modified),
  ].filter(Boolean);

  if (blocks.length === 0) {
    return summary;
  }

  return [summary.trimEnd(), ...blocks].join("\n\n");
}

function formatBlock(label: string, paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }

  return [`<${label}>`, ...paths.map((path) => `- ${path}`), `</${label}>`].join(
    "\n",
  );
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filename", "file", "target_file"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}
