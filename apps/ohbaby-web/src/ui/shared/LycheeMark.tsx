import type { ReactElement } from "react";

/**
 * Lychee, the agent's mark: a single-colour outline fruit with a leaf. It
 * strokes with `currentColor`, so its colour comes from CSS (`--brand-lychee`).
 * The ohbaby wordmark stays the product logo in the sidebar.
 */
export function LycheeMark(props: { readonly size: number }): ReactElement {
  return (
    <svg
      className="ohb-lychee-mark"
      role="img"
      aria-label="Lychee"
      width={props.size}
      height={props.size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M24 11c0-3 1-5 2.5-6.5" strokeWidth="1.6" />
      <path d="M26 7c4-4 10-3.5 12-1-4 3.5-9 3.5-12 1Z" strokeWidth="1.6" />
      <circle cx="24" cy="27" r="15" strokeWidth="1.8" />
      <path
        d="M15 23l3-2.5 3 2.5M21 23l3-2.5 3 2.5M27 23l3-2.5 3 2.5M18 30l3-2.5 3 2.5M24 30l3-2.5 3 2.5"
        strokeWidth="1.3"
      />
    </svg>
  );
}
