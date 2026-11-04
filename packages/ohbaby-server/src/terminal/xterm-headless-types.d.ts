/**
 * `@xterm/addon-serialize` types its terminal against `@xterm/xterm`, whose
 * typings pull the DOM lib into the whole server program once the web app's
 * copy is hoisted. The server only serializes headless terminals, so
 * tsconfig maps that import here.
 */
export type {
  IBufferRange,
  IMarker,
  ITerminalAddon,
  Terminal,
} from "@xterm/headless";
