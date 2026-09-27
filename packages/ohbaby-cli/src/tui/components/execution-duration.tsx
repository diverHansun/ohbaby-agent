import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createDurationAnchor,
  elapsedDurationMs,
  formatDurationSeconds,
} from "ohbaby-sdk";

export const DurationDiagnosticContext = createContext<
  ((identity: string) => void) | undefined
>(undefined);

export interface DurationSample {
  readonly serverNow: number;
  readonly receivedAt: number;
}
export const DurationSampleContext = createContext<DurationSample | undefined>(
  undefined,
);

export function useExecutionDuration(
  identity: string,
  startedAt?: number,
  endedAt?: number,
): string | undefined {
  const receivedSample = useContext(DurationSampleContext);
  const sample = endedAt === undefined ? receivedSample : undefined;
  const report = useContext(DurationDiagnosticContext);
  const reported = useRef<unknown>(undefined);
  const anchor = useMemo(
    () =>
      startedAt === undefined
        ? undefined
        : createDurationAnchor({
            startedAt,
            endedAt,
            serverNow: sample?.serverNow,
            monotonicNow: sample?.receivedAt ?? performance.now(),
          }),
    [identity, startedAt, endedAt, sample],
  );
  const [, tick] = useState(0);
  useEffect(() => {
    if (!anchor?.clockAnomaly || reported.current === anchor) return;
    reported.current = anchor;
    try {
      report?.(identity);
    } catch {
      /* Diagnostics cannot disrupt rendering. */
    }
  }, [anchor, identity, report]);
  useEffect(() => {
    if (!anchor || anchor.terminal) return;
    const timer = setInterval(() => {
      tick((n) => n + 1);
    }, 1000);
    return (): void => {
      clearInterval(timer);
    };
  }, [anchor]);
  const elapsed = elapsedDurationMs(anchor, performance.now());
  return elapsed === undefined
    ? undefined
    : formatDurationSeconds(elapsed / 1000);
}
