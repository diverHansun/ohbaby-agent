import { describe, expect, it } from "vitest";
import {
  type ActivityMotion,
  activityDotCount,
  activityDotStyle,
  activityKeyframes,
  activityPose,
} from "./activity-mark.js";

const SAMPLES = 480;
const motions: readonly ActivityMotion[] = [
  "thinking",
  "compacting",
  "running",
];
const dotSize: Readonly<Record<ActivityMotion, number>> = {
  thinking: 3.2,
  compacting: 2.5,
  running: 2.8,
};
const RUNNING_BEATS = 20;
const GRID_PITCH = 5.4;

function dots(motion: ActivityMotion): number[] {
  return Array.from({ length: activityDotCount(motion) }, (_, dot) => dot);
}

describe("activity mark motion", () => {
  it.each(motions)("%s closes its loop without a jump", (motion) => {
    for (const dot of dots(motion)) {
      const start = activityPose(motion, 0, dot);
      const end = activityPose(motion, 1, dot);
      expect(end.x).toBeCloseTo(start.x, 3);
      expect(end.y).toBeCloseTo(start.y, 3);
      expect(end.scale).toBeCloseTo(start.scale, 3);
      expect(end.opacity).toBeCloseTo(start.opacity, 3);
    }
  });

  it.each(motions)("%s stays inside its box", (motion) => {
    for (const dot of dots(motion)) {
      for (let step = 0; step <= SAMPLES; step += 1) {
        const pose = activityPose(motion, step / SAMPLES, dot);
        const radius = (dotSize[motion] * pose.scale) / 2;
        expect(Math.abs(pose.x) + radius).toBeLessThanOrEqual(8);
        expect(Math.abs(pose.y) + radius).toBeLessThanOrEqual(8);
      }
    }
  });

  it("moves the thinking dots along a continuous path", () => {
    for (const dot of dots("thinking")) {
      let previous = activityPose("thinking", 0, dot);
      for (let step = 1; step <= SAMPLES; step += 1) {
        const pose = activityPose("thinking", step / SAMPLES, dot);
        expect(
          Math.hypot(pose.x - previous.x, pose.y - previous.y),
        ).toBeLessThan(0.6);
        previous = pose;
      }
    }
  });

  it("only respawns a compacting dot while it is invisible", () => {
    for (let dot = 0; dot < 6; dot += 1) {
      const wrap = 1 - dot / 6;
      expect(
        activityPose("compacting", wrap - 0.0001, dot).opacity,
      ).toBeLessThan(0.01);
      expect(activityPose("compacting", wrap % 1, dot).opacity).toBeLessThan(
        0.01,
      );
    }
  });

  it("lands the running dots on separate cells that cover the 3x3 grid", () => {
    const visited = new Set<string>();
    for (let beat = 0; beat < RUNNING_BEATS; beat += 1) {
      const cells = dots("running").map((dot) => {
        const pose = activityPose("running", beat / RUNNING_BEATS, dot);
        expect(pose.opacity).toBe(1);
        expect(pose.scale).toBe(1);
        const column = pose.x / GRID_PITCH;
        const row = pose.y / GRID_PITCH;
        expect([-1, 0, 1]).toContainEqual(Math.round(column));
        expect(column).toBeCloseTo(Math.round(column), 6);
        expect(row).toBeCloseTo(Math.round(row), 6);
        return `${String(Math.round(column))},${String(Math.round(row))}`;
      });
      expect(new Set(cells).size).toBe(cells.length);
      cells.forEach((cell) => visited.add(cell));
    }
    expect(visited.size).toBe(9);
  });

  it("keeps a running dot faint while it travels between cells", () => {
    for (const dot of dots("running")) {
      for (let beat = 0; beat < RUNNING_BEATS; beat += 1) {
        const start = activityPose("running", beat / RUNNING_BEATS, dot);
        const middle = activityPose(
          "running",
          (beat + 0.5) / RUNNING_BEATS,
          dot,
        );
        const end = activityPose(
          "running",
          ((beat + 1) % RUNNING_BEATS) / RUNNING_BEATS,
          dot,
        );
        const hops = start.x !== end.x || start.y !== end.y;
        expect(middle.opacity).toBeCloseTo(hops ? 0.1 : 1, 6);
      }
    }
  });

  it("emits one keyframe per dot and a visible resting pose", () => {
    const keyframes = activityKeyframes();
    for (const motion of motions) {
      for (const dot of dots(motion)) {
        expect(keyframes).toContain(
          `@keyframes ohb-activity-${motion}-${String(dot)}{`,
        );
        expect(activityDotStyle(motion, dot).transform).toMatch(
          /^translate\(/u,
        );
      }
    }
    expect(
      dots("compacting").some(
        (dot) => Number(activityDotStyle("compacting", dot).opacity) > 0.5,
      ),
    ).toBe(true);
    expect(keyframes).not.toContain("NaN");
  });
});
