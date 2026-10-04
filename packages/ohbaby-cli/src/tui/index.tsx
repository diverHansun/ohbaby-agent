import { render, type Instance } from "ink";
import { OhbabyTerminalApp, type TerminalUiOptions } from "./app.js";
import {
  renderExitTranscript,
  type ExitTranscript,
} from "./exit-transcript.js";
import { createFrameCoalescingStdout } from "./terminal-output.js";

export { OhbabyTerminalApp };
export type { TerminalUiOptions };

export function renderTerminalUi(options: TerminalUiOptions): Instance {
  const stdout = process.stdout;
  const fullscreen = stdout.isTTY;
  let transcript: ExitTranscript | undefined;
  const instance = render(
    <OhbabyTerminalApp
      {...options}
      fullscreen={fullscreen}
      onExitTranscript={(value) => {
        transcript = value;
        options.onExitTranscript?.(value);
      }}
    />,
    {
      alternateScreen: fullscreen,
      interactive: fullscreen,
      incrementalRendering: true,
      // Root Stop and read-only child views own cancellation; Ink must not exit first.
      exitOnCtrlC: false,
      // Send each synchronized frame update as one write to avoid tearing in
      // terminals without DEC mode 2026.
      ...(fullscreen
        ? { maxFps: 60, stdout: createFrameCoalescingStdout(stdout) }
        : {}),
    },
  );
  if (!fullscreen) return instance;

  const printTranscript = async (): Promise<void> => {
    if (!transcript || stdout.destroyed || stdout.writableEnded) return;
    const text = renderExitTranscript(transcript, stdout.columns);
    if (!text.trim()) return;
    await new Promise<void>((resolve, reject) => {
      stdout.write(`${text}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };
  // Ink settles only after React cleanup, alternate-screen restoration and its
  // stdout barrier. Cache this continuation so all exit callers share one print.
  const exited = instance.waitUntilExit().then(
    async (result) => {
      await printTranscript();
      return result;
    },
    async (error: unknown) => {
      try {
        await printTranscript();
      } catch {
        /* Preserve the original exit error. */
      }
      throw error;
    },
  );
  // Signals may race waitUntilExit in the CLI; keep its rejection handled even
  // when that race exits early. Awaiting the returned promise still rejects.
  void exited.catch(() => undefined);
  return { ...instance, waitUntilExit: () => exited };
}
