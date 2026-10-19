import type { PermissionStateStore } from "../../permission/index.js";
import { isSystemReminderMessage } from "../../core/message/origin.js";
import type { ReminderBody, ReminderProvider } from "./index.js";

export function createModeReminderProvider(
  permissionState: Pick<PermissionStateStore, "getMode">,
): ReminderProvider {
  return {
    type: "mode",
    kind: "snapshot",
    audience: "primary",
    collect(context): ReminderBody {
      const mode = permissionState.getMode();
      let previousMode: unknown;
      for (const message of context.history) {
        if (!isSystemReminderMessage(message)) continue;
        for (const part of message.parts) {
          if (
            part.type === "text" &&
            !part.ignored &&
            part.text.trim() !== "" &&
            part.metadata?.reminderType === "mode"
          )
            previousMode = part.metadata.key;
        }
      }
      return {
        key: mode,
        text:
          mode === "plan"
            ? "Current mode: plan."
            : previousMode === "plan"
              ? "Current mode: auto; prior plan-mode constraints have ended."
              : "Current mode: auto.",
      };
    },
  };
}
