import { render } from "ink-testing-library";
import type { CoreAPI } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { Prompt } from "./index.js";
import { LayoutProvider } from "../../layout/context.js";
import { computeLayoutMetrics } from "../../layout/metrics.js";

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 35));
const PGUP = "\u001b[5~";
const PGDN = "\u001b[6~";

function prompt(): {
  readonly app: ReturnType<typeof render>;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly loadHistory: ReturnType<typeof vi.fn>;
  readonly press: (keys: readonly string[]) => Promise<void>;
} {
  const submit = vi.fn().mockResolvedValue({ sessionId: "s" });
  const loadHistory = vi.fn();
  // SAFETY: the prompt only needs this CoreAPI method in these input scenarios.
  const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
  const app = render(
    <LayoutProvider value={computeLayoutMetrics({ columns: 60, rows: 20 })}>
      <Prompt
        activeSessionId="s"
        catalog={null}
        disabled={false}
        client={client}
        onLoadHistory={loadHistory}
      />
    </LayoutProvider>,
  );
  const press = async (keys: readonly string[]): Promise<void> => {
    for (const key of keys) {
      app.stdin.write(key);
      await tick();
    }
  };
  return { app, submit, loadHistory, press };
}

describe("prompt cursor navigation through real Ink input", () => {
  it("maps single-line PgUp/PgDn to start/end without replaying history", async () => {
    const { app, submit, loadHistory, press } = prompt();
    try {
      await tick();
      await press(["middle", PGUP, PGUP, "A", PGDN, "Z", "\r"]);
      expect(submit).toHaveBeenCalledWith("AmiddleZ", expect.anything());
      expect(loadHistory).not.toHaveBeenCalled();
      // Session history still has an entry point when the input is empty.
      await press([PGUP]);
      expect(loadHistory).toHaveBeenCalledTimes(1);
    } finally {
      app.unmount();
    }
  });

  it("switches logical lines with PgUp/PgDn and retains the desired cell column", async () => {
    const { app, submit, loadHistory, press } = prompt();
    try {
      await tick();
      await press(["ab\ncdef\nuvwxyz", PGUP, PGUP, PGDN, "!", PGDN, "#", "\r"]);
      expect(submit).toHaveBeenCalledWith(
        "ab\ncdef!\nuvwxy#z",
        expect.anything(),
      );
      expect(loadHistory).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  });

  it("moves arrow keys within a multiline draft before recalling input history", async () => {
    const { app, submit, press } = prompt();
    try {
      await tick();
      await press([
        "old prompt",
        "\r",
        "abcd\nx\nabcd",
        "\u001b[A",
        "\u001b[A",
        "!",
        "\r",
      ]);
      expect(submit).toHaveBeenLastCalledWith(
        "abcd!\nx\nabcd",
        expect.anything(),
      );
      await press(["\u001b[A"]);
      expect(app.lastFrame()).toContain("abcd!");
      await press(["\u001b[B"]);
      expect(app.lastFrame()).not.toContain("abcd!");
    } finally {
      app.unmount();
    }
  });

  it("supports Ctrl+A/E without damaging emoji or combining graphemes", async () => {
    const { app, submit, press } = prompt();
    try {
      await tick();
      await press(["👩‍💻é中", "\u0001", "start", "\u0005", "end", "\r"]);
      expect(submit).toHaveBeenCalledWith("start👩‍💻é中end", expect.anything());
    } finally {
      app.unmount();
    }
  });
});
