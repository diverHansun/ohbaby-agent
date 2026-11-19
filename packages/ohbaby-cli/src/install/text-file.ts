import { readFileSync } from "node:fs";

export function readSingleLine(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n$/, "");
}
