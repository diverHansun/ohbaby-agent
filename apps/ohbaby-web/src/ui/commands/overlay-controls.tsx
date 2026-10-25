import type { ReactElement } from "react";
import { Spinner } from "../shared/Spinner.js";

export interface OverlayStatus {
  readonly kind: "busy" | "error" | "idle" | "success";
  readonly message: string;
}

export function OverlayStatusLine(props: {
  readonly status: OverlayStatus;
}): ReactElement | null {
  if (!props.status.message) {
    return null;
  }
  return (
    <div
      className={`ohb-structured-status ohb-structured-${props.status.kind}`}
    >
      {props.status.kind === "busy" ? <Spinner size={12} /> : null}
      {props.status.message}
    </div>
  );
}

export function OverlayResult(props: {
  readonly rows: readonly (readonly [string, string])[];
}): ReactElement {
  return (
    <div className="ohb-structured-result">
      {props.rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

export async function runOverlayAction(
  setStatus: (status: OverlayStatus) => void,
  action: () => Promise<string>,
  busyMessage: string,
): Promise<void> {
  try {
    setStatus({ kind: "busy", message: busyMessage });
    const message = await action();
    setStatus({ kind: "success", message });
  } catch (error) {
    setStatus({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
