/**
 * Motion for the conversation's waiting marks. Poses are plain functions of
 * loop progress, sampled into CSS keyframes, so the browser runs the animation
 * on transform and opacity alone. All units live in a 16-unit box.
 */
export type ActivityMotion = "thinking" | "compacting";

export interface ActivityPose {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
}

interface MotionSpec {
  readonly loopMs: number;
  readonly dots: number;
  readonly dotSize: number;
  readonly steps: number;
  /** Where the mark rests when reduced motion stops the animation. */
  readonly restAt: number;
  readonly pose: (progress: number, dot: number) => ActivityPose;
}

const BOX = 16;
const TAU = Math.PI * 2;
const TRIANGLE_RADIUS = 4.6;
const ROW_RADIUS = 5.2;

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const span = (value: number, from: number, to: number): number =>
  clamp((value - from) / (to - from));
const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * t;
const frac = (value: number): number => value - Math.floor(value);

function pose(x: number, y: number, scale = 1, opacity = 1): ActivityPose {
  return { x, y, scale, opacity };
}

function polar(radius: number, angle: number, scale = 1): ActivityPose {
  return pose(radius * Math.cos(angle), radius * Math.sin(angle), scale);
}

/**
 * Three dots: a twisting triangle spirals open into a row, the row rolls as a
 * wave and pirouettes around its middle dot, then spirals back to the triangle.
 */
function thinkingPose(progress: number, dot: number): ActivityPose {
  const home = -TAU / 4 + (TAU * dot) / 3;
  const rowRadius = dot === 0 ? 0 : ROW_RADIUS;
  const rowAngle = [home, Math.PI, TAU][dot] ?? home;

  if (progress < 0.24) {
    const t = smooth(span(progress, 0, 0.24));
    const twist =
      0.3 * Math.sin(TAU * t + (dot * TAU) / 3) * Math.sin(Math.PI * t);
    return polar(
      TRIANGLE_RADIUS + 0.9 * Math.sin(TAU * t),
      home + TAU * t + twist,
    );
  }
  if (progress < 0.36) {
    const t = smooth(span(progress, 0.24, 0.36));
    return polar(lerp(TRIANGLE_RADIUS, rowRadius, t), lerp(home, rowAngle, t));
  }
  if (progress < 0.62) {
    const t = span(progress, 0.36, 0.62);
    const order = [1, 0, 2][dot] ?? 0;
    const swell = Math.sin(Math.PI * t);
    const phase = TAU * (t * 2 - order / 3);
    return pose(
      (order - 1) * ROW_RADIUS + 1.1 * swell * Math.cos(phase),
      -3 * swell * Math.sin(phase),
    );
  }
  if (progress < 0.8) {
    const t = smooth(span(progress, 0.62, 0.8));
    if (dot === 0) return pose(0, 1.3 * Math.sin(TAU * t));
    const angle = rowAngle + TAU * t;
    return polar(
      ROW_RADIUS * (1 - 0.38 * Math.sin(Math.PI * t)),
      angle,
      1 + 0.18 * Math.sin(angle),
    );
  }
  const t = smooth(span(progress, 0.8, 1));
  return polar(
    lerp(rowRadius, TRIANGLE_RADIUS, t),
    lerp(rowAngle, home + TAU, t),
  );
}

/** Six dots spiral from the rim into a pulsing core, one after another. */
function compactingPose(progress: number, dot: number): ActivityPose {
  if (dot === 6)
    return pose(0, 0, 1.2 * (0.92 + 0.14 * Math.sin(TAU * progress * 3)));
  const q = frac(progress + dot / 6);
  const radius = 6.2 * Math.pow(1 - q, 0.85) + 0.2;
  const angle = TAU * (dot / 6 + q * 0.72) - TAU / 4;
  const visible = smooth(span(q, 0, 0.14)) * (1 - smooth(span(q, 0.86, 1)));
  return pose(
    radius * Math.cos(angle),
    radius * Math.sin(angle),
    0.38 + 0.72 * (1 - q),
    visible,
  );
}

const MOTIONS: Readonly<Record<ActivityMotion, MotionSpec>> = {
  thinking: {
    loopMs: 5200,
    dots: 3,
    dotSize: 3.2,
    steps: 120,
    restAt: 0,
    pose: thinkingPose,
  },
  compacting: {
    loopMs: 1900,
    dots: 7,
    dotSize: 2.5,
    steps: 48,
    restAt: 0.35,
    pose: compactingPose,
  },
};

const round = (value: number): string => String(Math.round(value * 100) / 100);

function transform(spec: MotionSpec, value: ActivityPose): string {
  const x = (value.x / spec.dotSize) * 100 - 50;
  const y = (value.y / spec.dotSize) * 100 - 50;
  return `translate(${round(x)}%, ${round(y)}%) scale(${round(value.scale)})`;
}

const keyframeName = (motion: ActivityMotion, dot: number): string =>
  `ohb-activity-${motion}-${String(dot)}`;

export function activityPose(
  motion: ActivityMotion,
  progress: number,
  dot: number,
): ActivityPose {
  return MOTIONS[motion].pose(progress, dot);
}

export function activityDotCount(motion: ActivityMotion): number {
  return MOTIONS[motion].dots;
}

/** Inline styles for one dot, resting in a clear pose if motion is reduced. */
export function activityDotStyle(
  motion: ActivityMotion,
  dot: number,
): Readonly<Record<string, string>> {
  const spec = MOTIONS[motion];
  const rest = spec.pose(spec.restAt, dot);
  const size = `${String((spec.dotSize / BOX) * 100)}%`;
  return {
    animation: `${keyframeName(motion, dot)} ${String(spec.loopMs)}ms linear infinite`,
    height: size,
    opacity: round(rest.opacity),
    transform: transform(spec, rest),
    width: size,
  };
}

/** Every waiting mark's keyframes, added to the document once. */
export function activityKeyframes(): string {
  return (Object.keys(MOTIONS) as ActivityMotion[])
    .flatMap((motion) => {
      const spec = MOTIONS[motion];
      return Array.from({ length: spec.dots }, (_, dot) => {
        const stops = Array.from({ length: spec.steps + 1 }, (_, step) => {
          const progress = step / spec.steps;
          const value = spec.pose(progress, dot);
          return `${round(progress * 100)}%{transform:${transform(spec, value)};opacity:${round(value.opacity)}}`;
        });
        return `@keyframes ${keyframeName(motion, dot)}{${stops.join("")}}`;
      });
    })
    .join("");
}
