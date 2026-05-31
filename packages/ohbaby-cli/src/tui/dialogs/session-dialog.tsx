import type { CoreAPI } from "ohbaby-sdk";
import type { TuiInteractionRequest } from "../store/snapshot.js";
import type { ReactElement } from "react";
import { SelectOneDialog } from "./select-one.js";

export interface SessionDialogProps {
  readonly client: CoreAPI;
  readonly interaction: TuiInteractionRequest;
  readonly title?: string;
}

export function SessionDialog({
  client,
  interaction,
  title = "Session",
}: SessionDialogProps): ReactElement {
  return (
    <SelectOneDialog client={client} interaction={interaction} title={title} />
  );
}
