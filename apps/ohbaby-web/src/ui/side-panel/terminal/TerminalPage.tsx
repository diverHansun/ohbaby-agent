import { type ReactElement, useState } from "react";
import type { TerminalApi } from "../../../api/daemon/terminals.js";
import { Banner } from "../../shared/Banner.js";
import type { SidePageStates } from "../side-pages.js";
import { type CreateTerminalSurface, TerminalView } from "./TerminalView.js";

/**
 * One terminal tab. Normal work shows only the screen; text appears only when
 * the user cannot type: a failed close, an exit, or a terminal that is gone.
 */
export function TerminalPage(props: {
  readonly api: TerminalApi;
  readonly state: SidePageStates["terminal"];
  readonly onExit: (exitCode: number) => void;
  readonly onMissing: () => void;
  readonly createSurface?: CreateTerminalSurface;
}): ReactElement {
  const { terminal, gone, exitCode } = props.state;
  // A tab reopened after its shell exited has no screen left to show.
  const [connectable] = useState(exitCode === undefined);
  // A record that disappeared says so, whatever its last state was.
  if (gone && exitCode === undefined) {
    return (
      <div className="ohb-terminal">
        <Banner tone="info" message="This terminal has ended." />
      </div>
    );
  }
  if (terminal.state === "close_failed") {
    return (
      <div className="ohb-terminal">
        <Banner
          tone="error"
          message={`This terminal could not be closed${terminal.error ? `: ${terminal.error}` : "."} Close it again to retry.`}
        />
      </div>
    );
  }
  // Restored mid-close after a reload: nothing to reconnect, the x still works.
  if (terminal.state === "closing" && exitCode === undefined)
    return <div className="ohb-terminal" />;
  if (connectable) {
    return (
      <TerminalView
        api={props.api}
        terminalId={terminal.id}
        onExit={props.onExit}
        onMissing={props.onMissing}
        createSurface={props.createSurface}
      />
    );
  }
  return (
    <div className="ohb-terminal">
      <Banner
        tone="info"
        message={
          exitCode === undefined
            ? "This terminal has ended."
            : `Process exited with code ${String(exitCode)}.`
        }
      />
    </div>
  );
}
