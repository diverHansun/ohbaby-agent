import { Check, Copy } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { IconButton } from "../shared/IconButton.js";
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
        ["Default workspace", about.defaultWorkspace],
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
            control={<CopyButton label={label} value={value} />}
          />
        ),
      )}
    </section>
  );
}

/** Copies quietly: the icon turns into a check for a moment, no notice. */
function CopyButton(props: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 1500);
    return (): void => {
      clearTimeout(timer);
    };
  }, [copied]);
  return (
    <IconButton
      label={copied ? `${props.label} copied` : `Copy ${props.label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(props.value)
          .then(() => {
            setCopied(true);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? (
        <Check aria-hidden="true" size={14} />
      ) : (
        <Copy aria-hidden="true" size={14} />
      )}
    </IconButton>
  );
}
