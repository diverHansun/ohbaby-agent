import type { ReactElement } from "react";
import { WandSparkles } from "lucide-react";

/**
 * A skill called with a slash, shown as part of the text: the wand and the
 * skill's name, no frame (skill UX frontend 05 §2.1). Display only.
 */
export function SkillToken(props: { readonly name: string }): ReactElement {
  return (
    <span
      aria-label={`Skill: ${props.name}`}
      className="ohb-skill-token"
      role="img"
      title={props.name}
    >
      <WandSparkles aria-hidden="true" className="ohb-skill-token-icon" />
      <span aria-hidden="true">{props.name}</span>
    </span>
  );
}
