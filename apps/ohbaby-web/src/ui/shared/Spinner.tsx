import type { ReactElement } from "react";

/** A small spinner. It stays animated under reduced motion because it conveys state. */
export function Spinner(props: {
  readonly size?: number;
  readonly label?: string;
}): ReactElement {
  const size = props.size ?? 14;
  return (
    <span
      className="ohb-spinner"
      role={props.label ? "status" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      style={{ width: size, height: size }}
    />
  );
}
