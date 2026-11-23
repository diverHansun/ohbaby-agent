import { type ReactElement, useInsertionEffect } from "react";
import {
  type ActivityMotion,
  activityDotCount,
  activityDotStyle,
  activityKeyframes,
} from "./activity-mark.js";

const STYLE_ID = "ohb-activity-keyframes";

/** The animated mark beside Thinking and Compacting. */
export function ActivityMark({
  motion,
}: {
  readonly motion: ActivityMotion;
}): ReactElement {
  useInsertionEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = activityKeyframes();
    document.head.append(style);
  }, []);
  return (
    <span className="ohb-activity-mark" aria-hidden="true">
      {Array.from({ length: activityDotCount(motion) }, (_, dot) => (
        <i key={dot} style={activityDotStyle(motion, dot)} />
      ))}
    </span>
  );
}
