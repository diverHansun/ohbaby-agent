// Message times read in the system time zone: the local getters below follow
// whatever zone the operating system sets, and the server's UTC instants are
// converted for display only (message time topic 02 A3, A4).

const pad = (value: number): string => String(value).padStart(2, "0");

const clockOf = (time: Date): string =>
  `${pad(time.getHours())}:${pad(time.getMinutes())}`;

const dayOf = (time: Date): string =>
  `${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;

/**
 * Minute-level time for a message's action row, dropping what matches today:
 * `14:32` today, `11-24 14:32` this year, `2025-11-24 14:32` before that.
 * Returns "" when the input is not a valid time.
 */
export function formatMessageTime(iso: string, now: number): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const today = new Date(now);
  if (time.getFullYear() !== today.getFullYear())
    return formatFullMessageTime(iso);
  if (
    time.getMonth() === today.getMonth() &&
    time.getDate() === today.getDate()
  )
    return clockOf(time);
  return `${dayOf(time)} ${clockOf(time)}`;
}

/** The full form for the tooltip: `2026-11-24 14:32`, or "" when invalid. */
export function formatFullMessageTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  return `${String(time.getFullYear())}-${dayOf(time)} ${clockOf(time)}`;
}
