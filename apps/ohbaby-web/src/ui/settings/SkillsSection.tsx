import { ChevronRight } from "lucide-react";
import type { UiSettingsSkill } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useState } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { SettingsRow } from "../shared/SettingsRow.js";
import { SectionHeader, SectionStatus } from "./SectionFrame.js";
import { useSettingsResource } from "./useSettingsResource.js";

const SOURCES: Readonly<Record<UiSettingsSkill["source"], string>> = {
  "user-native": "ohbaby",
  "claude-compatible": "Claude",
  "agents-compatible": "Agents",
  "codex-home": "Codex",
  plugin: "Plugins",
  "project-native": "Project",
};

/** Global (user-scope) skills only, grouped by source (D13). */
export function globalSkillGroups(
  skills: readonly UiSettingsSkill[],
): { readonly source: string; readonly skills: UiSettingsSkill[] }[] {
  const groups = new Map<string, UiSettingsSkill[]>();
  for (const skill of skills) {
    if (skill.scope !== "user") continue;
    const label = SOURCES[skill.source];
    const group = groups.get(label);
    if (group) group.push(skill);
    else groups.set(label, [skill]);
  }
  return [...groups].map(([source, rows]) => ({ source, skills: rows }));
}

/** Skills: a read-only list; a row expands into its description and path. */
export function SkillsSection(props: {
  readonly settings: SettingsLayer;
  readonly visible: boolean;
}): ReactElement {
  const resource = useSettingsResource(props.settings, "skills", props.visible);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const groups = resource.data ? globalSkillGroups(resource.data) : [];
  return (
    <section className="ohb-settings-section" aria-label="Skills">
      <SectionHeader title="Skills" />
      <SectionStatus
        resource={resource}
        empty={
          resource.data && groups.length === 0 ? "No skills found." : undefined
        }
      />
      {groups.map((group) => (
        <div key={group.source} className="ohb-settings-group">
          <div className="ohb-settings-group-title">
            <span>{group.source}</span>
          </div>
          {group.skills.map((skill) => {
            const key = `${skill.source}:${skill.name}`;
            const open = expanded.has(key);
            return (
              <div key={key} className="ohb-settings-row-wrap">
                <SettingsRow
                  expanded={open}
                  label={
                    <span className="ohb-settings-disclosure">
                      <ChevronRight
                        aria-hidden="true"
                        size={13}
                        className={`ohb-settings-disclosure-chevron${open ? " is-open" : ""}`}
                      />
                      {skill.name}
                    </span>
                  }
                  onClick={() => {
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }}
                />
                {open ? (
                  <div className="ohb-skill-details">
                    {skill.description ? <p>{skill.description}</p> : null}
                    <code className="ohb-mcp-code">{skill.location}</code>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
