export {
  buildCommandCatalog,
  filterCommandCatalogBySurface,
  validateUniqueAliases,
} from "./catalog.js";
export { CommandsEvent } from "./events.js";
export { createCommandRunContext } from "./run-context.js";
export { createBuiltinHandlers } from "./builtin.js";
export { createCommandService } from "./service.js";
export type {
  CommandHandler,
  CommandInteractionContext,
  CommandInteractionRequest,
  CommandModelProvider,
  CommandModelSummary,
  CommandRunContext,
  CommandService,
  CommandServiceOptions,
  CommandSessionProvider,
  CommandSessionSummary,
  CommandToolProvider,
  CommandToolSummary,
} from "./types.js";
