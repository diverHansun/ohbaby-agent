import { MEMORY_HEADER } from "./constants.js";
import type { MemoryEntry } from "./types.js";

const ENTRY_PATTERN = /^-\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):\s+(.+)$/;

function splitUserContent(content: string): string {
  const headerIndex = content.indexOf(MEMORY_HEADER);
  if (headerIndex === -1) {
    return content.trimEnd();
  }
  return content.slice(0, headerIndex).trimEnd();
}

function formatEntry(entry: Omit<MemoryEntry, "index">): string {
  return `- ${entry.timestamp}: ${entry.text}`;
}

function formatManagedContent(
  userContent: string,
  entries: readonly Omit<MemoryEntry, "index">[],
): string {
  const managed = entries.map(formatEntry).join("\n");
  const prefix = userContent.trimEnd();
  if (prefix) {
    return managed
      ? `${prefix}\n\n${MEMORY_HEADER}\n\n${managed}`
      : `${prefix}\n\n${MEMORY_HEADER}\n\n`;
  }
  return managed ? `${MEMORY_HEADER}\n\n${managed}` : `${MEMORY_HEADER}\n\n`;
}

function validateEntryIndex(
  entries: readonly MemoryEntry[],
  index: number,
): void {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new RangeError(`Memory entry index out of range: ${String(index)}`);
  }
}

export function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function parseMemoryEntries(content: string): MemoryEntry[] {
  const headerIndex = content.indexOf(MEMORY_HEADER);
  if (headerIndex === -1) {
    return [];
  }
  const afterHeader = content.slice(headerIndex + MEMORY_HEADER.length);
  const entries: MemoryEntry[] = [];

  for (const line of afterHeader.split(/\r?\n/u)) {
    const match = ENTRY_PATTERN.exec(line.trim());
    if (!match) {
      continue;
    }
    entries.push({
      index: entries.length,
      timestamp: match[1],
      text: match[2],
    });
  }

  return entries;
}

export function computeAddedMemoryContent(
  currentContent: string,
  fact: string,
  timestamp: string,
): string {
  const entries = parseMemoryEntries(currentContent).map(
    ({ timestamp: entryTimestamp, text }) => ({
      timestamp: entryTimestamp,
      text,
    }),
  );
  entries.push({ timestamp, text: fact });

  return formatManagedContent(splitUserContent(currentContent), entries);
}

export function updateMemoryEntry(
  currentContent: string,
  index: number,
  newText: string,
): string {
  const entries = parseMemoryEntries(currentContent);
  validateEntryIndex(entries, index);

  return formatManagedContent(
    splitUserContent(currentContent),
    entries.map((entry) => ({
      timestamp: entry.timestamp,
      text: entry.index === index ? newText : entry.text,
    })),
  );
}

export function removeMemoryEntry(
  currentContent: string,
  index: number,
): string {
  const entries = parseMemoryEntries(currentContent);
  validateEntryIndex(entries, index);

  return formatManagedContent(
    splitUserContent(currentContent),
    entries
      .filter((entry) => entry.index !== index)
      .map((entry) => ({ timestamp: entry.timestamp, text: entry.text })),
  );
}
