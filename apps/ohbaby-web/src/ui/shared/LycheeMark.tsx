import type { ReactElement } from "react";

// The lychee shell centred on (24, 27): a circle of twelve outward bumps, so
// the bumpy rind shows in the silhouette and survives at favicon size.
const SHELL =
  "M39 27A4.2 4.2 0 0 1 36.99 34.5A4.2 4.2 0 0 1 31.5 39.99A4.2 4.2 0 0 1 24 42A4.2 4.2 0 0 1 16.5 39.99A4.2 4.2 0 0 1 11.01 34.5A4.2 4.2 0 0 1 9 27A4.2 4.2 0 0 1 11.01 19.5A4.2 4.2 0 0 1 16.5 14.01A4.2 4.2 0 0 1 24 12A4.2 4.2 0 0 1 31.5 14.01A4.2 4.2 0 0 1 36.99 19.5A4.2 4.2 0 0 1 39 27Z";

/**
 * Lychee, the agent's mark: one outline lychee with a bumpy rim, a few rind
 * marks, a stem and a green leaf. The bumpy outline keeps it from reading as an
 * apple (D36). The fruit strokes with `currentColor`, so its red comes from CSS
 * (`--brand-lychee`). The ohbaby wordmark stays the product logo.
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
      <path d="M24 12c0-3 1-5 2.5-6.5" strokeWidth="2" />
      <path
        className="ohb-lychee-leaf"
        d="M26 7c4-4 10-3.5 12-1-4 3.5-9 3.5-12 1Z"
        strokeWidth="1.4"
      />
      <path d={SHELL} strokeWidth="2.2" />
      <path
        d="M19 24l1.5 1.5M27 22l1.5 1.5M23 30l1.5 1.5M30 30l1.5 1.5M17 32l1.5 1.5"
        strokeWidth="1.6"
      />
    </svg>
  );
}
