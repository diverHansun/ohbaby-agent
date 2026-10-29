import type { UiSubagentInstance } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { Spinner } from "../../shared/Spinner.js";
import { instanceStatusLabel, isFailedInstance } from "./instance-status.js";

/**
 * A quiet status: an amber dot while waiting for approval, a spinner while it
 * runs or cleans up, the danger ink for failures and plain text otherwise.
 */
export function InstanceStatus(props: {
  readonly instance: UiSubagentInstance;
  readonly role?: "status";
}): ReactElement {
  const { instance } = props;
  const working =
    !instance.approvalBlocked &&
    (instance.status === "running" ||
      instance.status === "pending" ||
      instance.settling);
  return (
    <span
      className={`ohb-subagent-instance-status${isFailedInstance(instance) ? " is-failed" : ""}`}
      role={props.role}
    >
      {instance.approvalBlocked ? (
        <span className="ohb-subagent-instance-dot" aria-hidden="true" />
      ) : working ? (
        <Spinner size={10} />
      ) : null}
      {instanceStatusLabel(instance)}
    </span>
  );
}
