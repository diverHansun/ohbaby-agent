import type { ReactElement } from "react";

/** The three-colour “oh/ba/by” product wordmark (sidebar and bootstrap error). */
export function Wordmark(props: { readonly size: "sm" | "md" }): ReactElement {
  return (
    <span
      className={`ohb-wordmark ohb-wordmark-${props.size}`}
      aria-label="ohbaby"
    >
      <span>oh</span>
      <span>ba</span>
      <span>by</span>
    </span>
  );
}
