import type { ReactElement } from "react";

/** Skin texture: a hexagonal grid of dots inside the fruit. */
const DOTS: readonly (readonly [number, number])[] = [
  [18.9, 19.77],
  [22.3, 19.77],
  [25.7, 19.77],
  [29.1, 19.77],
  [17.2, 22.71],
  [20.6, 22.71],
  [24.0, 22.71],
  [27.4, 22.71],
  [30.8, 22.71],
  [15.5, 25.66],
  [18.9, 25.66],
  [22.3, 25.66],
  [25.7, 25.66],
  [29.1, 25.66],
  [32.5, 25.66],
  [13.8, 28.6],
  [17.2, 28.6],
  [20.6, 28.6],
  [24.0, 28.6],
  [27.4, 28.6],
  [30.8, 28.6],
  [34.2, 28.6],
  [15.5, 31.54],
  [18.9, 31.54],
  [22.3, 31.54],
  [25.7, 31.54],
  [29.1, 31.54],
  [32.5, 31.54],
  [17.2, 34.49],
  [20.6, 34.49],
  [24.0, 34.49],
  [27.4, 34.49],
  [30.8, 34.49],
  [18.9, 37.43],
  [22.3, 37.43],
  [25.7, 37.43],
  [29.1, 37.43],
];

/**
 * Lychee, the agent's mark: a fine-line fruit with a dotted skin, a stem and
 * a leaf (D26, redrawn for D31). It uses `currentColor`, so its colour comes
 * from CSS (`--brand-lychee`). The ohbaby wordmark stays the product logo.
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
      <circle
        cx="24"
        cy="28.6"
        r="13.2"
        fill="currentColor"
        fillOpacity="0.06"
        strokeWidth="1.6"
      />
      <g fill="currentColor" fillOpacity="0.5" stroke="none">
        {DOTS.map(([x, y]) => (
          <circle key={`${String(x)}-${String(y)}`} cx={x} cy={y} r="0.62" />
        ))}
      </g>
      <path d="M24 15.4c0-2.8 0.9-5 2.8-6.6" strokeWidth="1.5" />
      <path
        d="M26.6 9c2.6-3.6 7.2-5.2 11.4-4.1-1.2 4.3-6.2 6.9-11.4 4.1Z"
        fill="currentColor"
        fillOpacity="0.12"
        strokeWidth="1.5"
      />
      <path
        d="M27.9 8.6c3-1 5.8-1.9 8.6-2.8"
        strokeWidth="0.9"
        strokeOpacity="0.6"
      />
    </svg>
  );
}
