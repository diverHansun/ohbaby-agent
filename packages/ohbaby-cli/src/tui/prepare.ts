import { setTerminalColors } from "./theme/detect.js";
import { probeTerminalColors } from "./theme/terminal-colors.js";

/** Detect the terminal's real background so the theme can match it. */
export async function prepareTerminalUi(): Promise<void> {
  setTerminalColors(await probeTerminalColors());
}
