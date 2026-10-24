import type { ReactElement, ReactNode } from "react";
import { LycheeMark } from "../shared/LycheeMark.js";

/**
 * Empty-state heading above the composer card: the Lychee mark and, for a
 * new-chat draft, the project picker. An empty existing session shows the
 * mark alone (04 §2.2).
 */
export function DraftHero(props: {
  readonly picker?: ReactNode;
}): ReactElement {
  return (
    <div className="ohb-draft-hero">
      <LycheeMark size={56} />
      {props.picker}
    </div>
  );
}
