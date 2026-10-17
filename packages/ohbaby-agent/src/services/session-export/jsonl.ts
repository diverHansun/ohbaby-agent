import type { ExportDocument } from "./types.js";

export function renderJsonl(document: ExportDocument): string {
  return (
    [document.header, ...document.messages]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}
