export { IrisError, formatError, getErrorMessage } from "./error.js";
export { contains, containsOrEqual, normalizePath, overlaps } from "./paths.js";
export { lazy, lazyAsync } from "./lazy.js";
export {
  checkEmptyContent,
  formatWithLineNumbers,
  type FormatOptions,
} from "./format.js";
export { truncateIfTooLong } from "./truncate.js";
export {
  detectPaths,
  getCommandRoots,
  matchesPattern,
  parseCommand,
  type CommandDetail,
  type ParsedCommand,
} from "./command-parser/index.js";
