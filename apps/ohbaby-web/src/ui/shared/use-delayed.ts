import { useEffect, useState } from "react";

/** True once `flag` has stayed true for `delay` ms; answers within it show nothing (04 §3). */
export function useDelayed(flag: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => {
      setShown(true);
    }, delay);
    return (): void => {
      clearTimeout(timer);
    };
  }, [flag, delay]);
  return shown;
}
