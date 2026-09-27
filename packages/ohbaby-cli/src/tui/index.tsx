import { render, type Instance } from "ink";
import { OhbabyTerminalApp, type TerminalUiOptions } from "./app.js";

export { OhbabyTerminalApp };
export type { TerminalUiOptions };

export function renderTerminalUi(options: TerminalUiOptions): Instance {
  return render(<OhbabyTerminalApp {...options} />, {
    incrementalRendering: true,
    // Root Stop and read-only child views own cancellation; Ink must not exit first.
    exitOnCtrlC: false,
  });
}
