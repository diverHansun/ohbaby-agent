import {
  File,
  FileCode,
  FileImage,
  FileText,
  type LucideIcon,
} from "lucide-react";

/** `reports/summary.md` → `{ name: "summary.md", folder: "reports" }`. */
export function splitFilePath(path: string): {
  readonly name: string;
  readonly folder: string;
} {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { name: path, folder: "" }
    : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

/**
 * Sizes in 1,024-byte units, the units the server's preview limits use, so a
 * file shown as 1.0 MB is the most a text preview takes.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1023.95 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? "GB"}`;
}

// The server previews these as images; SVG comes back as its source text.
const IMAGE = /\.(png|jpe?g|gif|webp)$/iu;
const CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|zsh|bash|sql|html|svg|css|scss|ya?ml|toml|xml)$/iu;
const TEXT = /\.(md|markdown|txt|log|csv|tsv|output|diff|patch)$/iu;

/** A row icon guessed from the name; the server decides what can be shown. */
export function fileIcon(name: string): LucideIcon {
  if (IMAGE.test(name)) return FileImage;
  if (CODE.test(name)) return FileCode;
  if (TEXT.test(name)) return FileText;
  return File;
}

/** Markdown renders by default; its source stays one click away. */
export function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/iu.test(name);
}
