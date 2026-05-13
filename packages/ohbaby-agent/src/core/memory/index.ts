import { MemoryEvent } from "./events.js";

export { MemoryEvent } from "./events.js";
export { createMemoryManager } from "./memory-manager.js";
export {
  computeAddedMemoryContent,
  formatTimestamp,
  parseMemoryEntries,
  removeMemoryEntry,
  updateMemoryEntry,
} from "./memory-parser.js";
export {
  findProjectMemoryPath,
  getGlobalMemoryPath,
} from "./memory-discovery.js";
export { MemoryTools } from "./memory-tools.js";
export type {
  AddMemoryInput,
  MemoryEntry,
  MemoryManager,
  MemoryManagerOptions,
  MemoryScope,
  MemoryToolDefinition,
  MergedMemory,
  ProjectInfo,
  ProjectResolver,
  RemoveMemoryInput,
  UpdateMemoryInput,
} from "./types.js";

export const Memory: { readonly Event: typeof MemoryEvent } = {
  Event: MemoryEvent,
};
