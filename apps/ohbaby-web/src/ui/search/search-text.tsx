import type { ReactNode } from "react";

/** Whitespace separates keywords, as the server splits them. */
export function searchKeywords(query: string): readonly string[] {
  return query
    .trim()
    .split(/\s+/u)
    .filter((keyword) => keyword !== "");
}

/** SQLite's LIKE folds ASCII letters only; highlights must agree with it. */
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/gu, (char) => char.toLowerCase());
}

/** Marks every literal occurrence of every keyword; overlapping marks merge. */
export function highlightKeywords(text: string, query: string): ReactNode {
  const folded = foldAscii(text);
  const ranges: [number, number][] = [];
  for (const keyword of searchKeywords(query).map(foldAscii)) {
    for (
      let index = folded.indexOf(keyword);
      index >= 0;
      index = folded.indexOf(keyword, index + 1)
    )
      ranges.push([index, index + keyword.length]);
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    parts.push(
      text.slice(cursor, start),
      <mark key={start}>{text.slice(start, end)}</mark>,
    );
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts;
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** A coarse age by local calendar day: Today, Yesterday, Past week, Past month, then "Mar 2026". */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Past week";
  if (days <= 30) return "Past month";
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
