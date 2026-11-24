import { useEffect, useState } from "react";

const dayKey = (time: number): string => new Date(time).toDateString();

/**
 * A clock that moves only when the local date changes, so times written
 * relative to today ("14:32" versus "11-23 14:32") roll over at midnight.
 * A timer fires just after each local midnight; a page coming back into view
 * re-checks too, since a sleeping computer can delay the timer.
 */
export function useDayClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const current = new Date();
      // Built from the date, not +24h, so daylight saving shifts don't drift.
      const nextMidnight = new Date(
        current.getFullYear(),
        current.getMonth(),
        current.getDate() + 1,
      );
      timer = setTimeout(
        tick,
        nextMidnight.getTime() - current.getTime() + 1000,
      );
    };
    const tick = (): void => {
      const time = Date.now();
      setNow((previous) =>
        dayKey(previous) === dayKey(time) ? previous : time,
      );
      clearTimeout(timer);
      schedule();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") tick();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return (): void => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return now;
}
