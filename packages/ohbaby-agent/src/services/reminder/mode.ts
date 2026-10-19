import type { PermissionStateStore } from "../../permission/index.js";
import type { ReminderBody, ReminderProvider } from "./index.js";

export function createModeReminderProvider(
  permissionState: Pick<PermissionStateStore, "getMode">,
): ReminderProvider {
  return {
    type: "mode",
    kind: "snapshot",
    audience: "primary",
    collect(): ReminderBody {
      const mode = permissionState.getMode();
      return {
        key: mode,
        text:
          mode === "plan"
            ? "Current mode: plan."
            : "Current mode: auto; prior plan-mode constraints have ended.",
      };
    },
  };
}
