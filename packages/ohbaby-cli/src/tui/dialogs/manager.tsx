import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type {
  CoreAPI,
  UiPermissionRequest,
  PermissionSyncState,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useTuiLayout } from "../layout/context.js";
import { ConfirmDialog } from "./confirm.js";
import { ModelDialog } from "./model-dialog.js";
import { PermissionDialog } from "./permission-dialog.js";
import { SelectOneDialog } from "./select-one.js";
import { SessionDialog } from "./session-dialog.js";
import type { TuiInteractionRequest } from "../store/snapshot.js";

export interface DialogManagerProps {
  readonly client: CoreAPI;
  readonly controllableRun?: boolean;
  readonly approvalStatus?: string;
  readonly approvalRetryHint?: string;
  readonly interactions: readonly TuiInteractionRequest[];
  readonly permissions: readonly UiPermissionRequest[];
  readonly permissionSync: PermissionSyncState;
  readonly onRetryPermissions: () => void;
}

export function DialogManager({
  client,
  controllableRun,
  approvalStatus,
  approvalRetryHint,
  interactions,
  permissions,
  permissionSync,
  onRetryPermissions,
}: DialogManagerProps): ReactElement {
  const layout = useTuiLayout();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const selectedIndex = Math.max(
    0,
    permissions.findIndex((request) => request.id === selectedId),
  );
  useInput((value, key) => {
    if ((value === "[" || value === "]") && permissions.length > 1) {
      const next =
        (selectedIndex + (value === "]" ? 1 : -1) + permissions.length) %
        permissions.length;
      setSelectedId(permissions[next].id);
    }
    if (
      !key.ctrl &&
      !key.meta &&
      value.toLowerCase() === "r" &&
      permissionSync.status === "error"
    )
      onRetryPermissions();
  });
  if (permissions.length > 0) {
    const request = permissions[selectedIndex];
    const binding = permissionSync.binding;
    return (
      <Box flexDirection="column">
        {permissions.length > 1 ? (
          <Text dimColor wrap="truncate-end">
            Request {String(selectedIndex + 1)} of {String(permissions.length)}{" "}
            · [ / ] choose request
          </Text>
        ) : null}
        <PermissionDialog
          client={client}
          controllableRun={controllableRun}
          maxHeight={Math.max(
            0,
            (layout.approvalRows ?? layout.rows - 3) -
              (permissions.length > 1 ? 1 : 0),
          )}
          syncError={permissionSync.error ?? approvalStatus}
          retryHint={
            [
              permissionSync.status === "error"
                ? "R retry approval sync"
                : undefined,
              approvalRetryHint,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          request={request}
          ready={
            permissionSync.status === "ready" &&
            binding?.rootSessionId === request.rootSessionId
          }
          context={
            binding === null
              ? undefined
              : {
                  permissionEpoch: binding.permissionEpoch,
                  rootSessionId: binding.rootSessionId,
                  ...(binding.bindingGeneration === 0
                    ? {}
                    : { bindingGeneration: binding.bindingGeneration }),
                }
          }
          onResync={onRetryPermissions}
        />
      </Box>
    );
  }
  if (
    permissionSync.status === "error" ||
    permissionSync.status === "unavailable"
  ) {
    return (
      <Text color="red">
        {permissionSync.error}
        {permissionSync.status === "error" ? " · R retry approval sync" : ""}
      </Text>
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
      <SelectOneDialog
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
