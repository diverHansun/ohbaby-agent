import type { ReactElement } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { CopyButton } from "../shared/CopyButton.js";
import { SettingsRow } from "../shared/SettingsRow.js";
import { SectionHeader, SectionStatus } from "./SectionFrame.js";
import { useSettingsResource } from "./useSettingsResource.js";

/** About: version and directories, each copyable; absent items are left out. */
export function AboutSection(props: {
  readonly settings: SettingsLayer;
  readonly visible: boolean;
}): ReactElement {
  const resource = useSettingsResource(props.settings, "about", props.visible);
  const about = resource.data;
  const rows: [string, string | undefined][] = about
    ? [
        ["Version", about.version],
        ["ohbaby home", about.ohbabyHome],
        ["Default directory", about.defaultDirectory],
        ["Diagnostics file", about.diagnosticsFile],
        ["Log directory", about.logDirectory],
      ]
    : [];
  return (
    <section className="ohb-settings-section" aria-label="About">
      <SectionHeader title="About" />
      <SectionStatus resource={resource} />
      {rows.map(([label, value]) =>
        value === undefined ? null : (
          <SettingsRow
            key={label}
            label={label}
            value={<code className="ohb-about-value">{value}</code>}
            control={
              <CopyButton
                label={`Copy ${label}`}
                copiedLabel={`${label} copied`}
                text={value}
              />
            }
          />
        ),
      )}
    </section>
  );
}
