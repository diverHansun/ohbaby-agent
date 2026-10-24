const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact age for a sidebar row (03 §4.4, like Cursor): `now`, `5m`, `3h`,
 * `2d`, `3w`, `4mo`, `2y`. Unreadable or future times show `now`.
 */
export function relativeTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const age = Math.max(0, now - time);
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${String(Math.floor(age / MINUTE))}m`;
  if (age < DAY) return `${String(Math.floor(age / HOUR))}h`;
  if (age < 7 * DAY) return `${String(Math.floor(age / DAY))}d`;
  if (age < 30 * DAY) return `${String(Math.floor(age / (7 * DAY)))}w`;
  if (age < 365 * DAY) return `${String(Math.floor(age / (30 * DAY)))}mo`;
  return `${String(Math.floor(age / (365 * DAY)))}y`;
}
