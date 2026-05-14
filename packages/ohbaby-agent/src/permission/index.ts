import { Bus } from "../bus/index.js";
import { PermissionEvent } from "./events.js";
import { createPermissionManager } from "./manager.js";

export { PermissionEvent } from "./events.js";
export {
  generatePermissionPattern,
  inferPermissionType,
  matchPermissionPattern,
} from "./matcher.js";
export { createPermissionManager } from "./manager.js";
export {
  PermissionRejectedError,
  PermissionRejectedWithSuggestionError,
} from "./types.js";
export type {
  PermissionAskInput,
  PermissionEventResponse,
  PermissionInfo,
  PermissionManager,
  PermissionPatternInput,
  PermissionResponse,
  PermissionToolCategory,
  PermissionType,
  SchedulerPermissionResponse,
  SystemPermissionResponse,
} from "./types.js";

export const Permission = {
  Event: PermissionEvent,
  ...createPermissionManager({ bus: Bus }),
} as const;
