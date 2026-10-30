import type { UiSubagentInstance } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { StatusGlyph } from "../../shared/StatusGlyph.js";
import {
  instanceStatusLabel,
  instanceStatusTone,
  isFailedInstance,
} from "./instance-status.js";

/** A quiet status: one small glyph and the label, failures in the danger ink. */
export function InstanceStatus(props: {
  readonly instance: UiSubagentInstance;
  readonly role?: "status";
}): ReactElement {
  const { instance } = props;
  return (
    <span
      className={`ohb-subagent-instance-status${isFailedInstance(instance) ? " is-failed" : ""}`}
      role={props.role}
    >
      <StatusGlyph tone={instanceStatusTone(instance)} />
      {instanceStatusLabel(instance)}
    </span>
  );
}
