export { computeBudgetReport, isSafetyCapReached } from "./budget.js";
export {
  GOAL_SAFETY_CAP_TURNS,
  MAX_GOAL_OBJECTIVE_LENGTH,
} from "./constants.js";
export { driveGoal, type DriveGoalDeps } from "./driver.js";
export { GoalError, type GoalErrorCode } from "./errors.js";
export {
  escapeUntrustedText,
  formatGoalStatusLines,
  renderGoalContextNote,
  renderGoalTurnPrompt,
} from "./injection.js";
export {
  createSqliteGoalPersistence,
  InMemoryGoalPersistence,
} from "./persistence.js";
export { GoalService, type GoalServiceDeps } from "./service.js";
export { createGoalTools, type GoalToolBackend } from "./tools.js";
export { GoalStore, type GoalStoreDeps } from "./store.js";
export type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeKind,
  GoalPersistencePort,
  GoalRecord,
  GoalRecordData,
  GoalSnapshot,
  GoalStatus,
  GoalTurnOutcome,
  GoalTurnRunner,
  GoalUsage,
} from "./types.js";
