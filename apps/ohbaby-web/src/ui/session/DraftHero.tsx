import { type ReactElement, type ReactNode, useState } from "react";
import { LycheeMark } from "../shared/LycheeMark.js";

/**
 * Empty-state heading above the composer card: the Lychee mark, a greeting
 * for the time of day and, for a new-chat draft, the workspace picker. An empty
 * existing session shows no picker (04 §2.2).
 */
export function DraftHero(props: {
  readonly picker?: ReactNode;
}): ReactElement {
  // Fixed for the mount so the line never changes under the user.
  const [greeting] = useState(() => greetingFor(new Date().getHours()));
  return (
    <div className="ohb-draft-hero">
      <LycheeMark size={56} />
      <p className="ohb-draft-greeting">{greeting}</p>
      {props.picker}
    </div>
  );
}

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  if (hour >= 18 && hour < 23) return "Good evening";
  return "Working late?";
}
