import { useEffect, useState } from "react";

/** Re-renders once a minute so relative times stay current. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return (): void => {
      clearInterval(timer);
    };
  }, []);
  return now;
}
