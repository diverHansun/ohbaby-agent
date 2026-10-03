import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import type { CoreAPI } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { Prompt } from "./index.js";
import { LayoutProvider } from "../../layout/context.js";
import { computeLayoutMetrics } from "../../layout/metrics.js";
import { visibleWidth } from "../../render/wrap.js";

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));

describe("prompt physical-row viewport", () => {
  it("keeps long drafts bounded through paste, Home/End and input history without truncating submission", async () => {
    const layout = computeLayoutMetrics({ columns: 60, rows: 20 });
    const submit = vi.fn(() => Promise.resolve({ sessionId: "session_1" }));
    const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
    const view = (disabled = false): ReactElement => (
      <LayoutProvider value={layout}>
        <Prompt
          activeSessionId="session_1"
          catalog={null}
          client={client}
          disabled={disabled}
        />
      </LayoutProvider>
    );
    const app = render(view());
    await tick();
    const text = `start${"中文❤️👩‍💻".repeat(70)}end`;
    app.stdin.write(text);
    await tick();
    const checkBounds = (): void => {
      const rows = (app.lastFrame() ?? "").split("\n");
      expect(rows.length).toBeLessThanOrEqual(8);
      expect(
        rows.every((row) => visibleWidth(row) <= layout.contentWidth),
      ).toBe(true);
    };
    checkBounds();
    expect(app.lastFrame()).toContain("end");
    expect(app.lastFrame()).not.toContain("start");
    expect(app.lastFrame()).toContain("↑ ");
    app.stdin.write("\u001b[H");
    await tick();
    expect(app.lastFrame()).toContain("> start");
    expect(app.lastFrame()).not.toContain("↑ ");
    checkBounds();
    app.stdin.write("\u001b[F");
    await tick();
    expect(app.lastFrame()).toContain("end");
    checkBounds();
    app.stdin.write("\r");
    await tick();
    expect(submit).toHaveBeenCalledWith(
      text,
      expect.objectContaining({ sessionId: "session_1" }),
    );
    app.stdin.write("\u001b[A");
    await tick();
    expect(app.lastFrame()).toContain("end");
    checkBounds();
    app.stdin.write("\u001b[B");
    await tick();
    const multiline = Array.from(
      { length: 30 },
      (_, index) => `line ${String(index)}`,
    ).join("\n");
    app.stdin.write(multiline);
    await tick();
    checkBounds();
    expect(app.lastFrame()).toContain("line 29");
    expect(app.lastFrame()).not.toContain("line 0");
    app.rerender(view(true));
    await tick();
    expect((app.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(7);
    expect(app.lastFrame()).toContain("line 29");
    app.stdin.write("\r");
    await tick();
    expect(submit).toHaveBeenCalledTimes(1);
    app.rerender(view());
    await tick();
    expect(app.lastFrame()).toContain("line 29");
    app.stdin.write("\r");
    await tick();
    expect(submit).toHaveBeenLastCalledWith(
      multiline,
      expect.objectContaining({ sessionId: "session_1" }),
    );
    app.unmount();
  });
});
