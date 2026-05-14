import type {
  TuiBackendClient,
  TuiInteractionRequest,
} from "../store/snapshot.js";
import type { ReactElement } from "react";
import { SelectOneDialog } from "./select-one.js";

export interface ModelDialogProps {
  readonly client: TuiBackendClient;
  readonly interaction: TuiInteractionRequest;
}

export function ModelDialog({
  client,
  interaction,
}: ModelDialogProps): ReactElement {
  return (
    <SelectOneDialog
      client={client}
      interaction={interaction}
      title="Model"
    />
  );
}
