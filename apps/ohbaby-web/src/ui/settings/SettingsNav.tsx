import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { SETTINGS_SECTIONS, type SettingsSection } from "./sections.js";

/** Left column of the settings dialog; a full-width list on phones. */
export function SettingsNav(props: {
  readonly current: SettingsSection;
  readonly onSelect: (section: SettingsSection) => void;
}): ReactElement {
  return (
    <nav className="ohb-settings-nav" aria-label="Settings sections">
      {SETTINGS_SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          className="ohb-settings-nav-item"
          aria-current={section.id === props.current ? "page" : undefined}
          onClick={() => {
            props.onSelect(section.id);
          }}
        >
          <span>{section.label}</span>
          <ChevronRight
            aria-hidden="true"
            size={14}
            className="ohb-settings-nav-chevron"
          />
        </button>
      ))}
    </nav>
  );
}
