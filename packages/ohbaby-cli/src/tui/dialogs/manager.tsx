import type { UiPermissionRequest } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { ConfirmDialog } from "./confirm.js";
import { ModelDialog } from "./model-dialog.js";
import { PermissionDialog } from "./permission-dialog.js";
import { SessionDialog } from "./session-dialog.js";
import type {
  TuiBackendClient,
  TuiInteractionRequest,
} from "../store/snapshot.js";

export interface DialogManagerProps {
  readonly client: TuiBackendClient;
  readonly interactions: readonly TuiInteractionRequest[];
  readonly permissions: readonly UiPermissionRequest[];
}

export function DialogManager({
  client,
  interactions,
  permissions,
}: DialogManagerProps): ReactElement {
  if (permissions.length > 0) {
    return (
      <PermissionDialog
        client={client}
        key={permissions[0].id}
        request={permissions[0]}
      />
    );
  }

  if (interactions.length === 0) {
    return <></>;
  }

  const interaction = interactions[0];

  if (interaction.kind === "select-one" && interaction.subject === "model") {
    return (
      <ModelDialog
        client={client}
        interaction={interaction}
        key={interaction.interactionId}
      />
    );
  }

  if (interaction.kind === "select-one" && interaction.subject === "session") {
    return (
      <SessionDialog
        client={client}
        interaction={interaction}
        key={interaction.interactionId}
      />
    );
  }

  if (interaction.kind === "select-one") {
    return (
      <SessionDialog
        client={client}
        key={interaction.interactionId}
        interaction={interaction}
        title={interaction.title ?? "Select"}
      />
    );
  }

  return (
    <ConfirmDialog
      client={client}
      interaction={interaction}
      key={interaction.interactionId}
    />
  );
}
