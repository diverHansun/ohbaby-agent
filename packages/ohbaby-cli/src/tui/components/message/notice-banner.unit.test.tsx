import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../../theme/index.js";
import { NoticeBanner } from "./notice-banner.js";

describe("NoticeBanner", () => {
  it("renders command output without exposing command run ids", () => {
    const app = render(
      <ThemeProvider>
        <NoticeBanner
          commandNotices={[
            {
              commandId: "command_42",
              id: "notice_1",
              kind: "result",
              text: "Status\nRuntime idle",
            },
          ]}
          notices={[]}
        />
      </ThemeProvider>,
    );

    expect(app.lastFrame()).toContain("Status");
    expect(app.lastFrame()).toContain("Runtime idle");
    expect(app.lastFrame()).not.toContain("command_42");
    expect(app.lastFrame()).not.toContain("command ");
  });

  it("keeps failed commands visible as errors", () => {
    const app = render(
      <ThemeProvider>
        <NoticeBanner
          commandNotices={[
            {
              commandId: "command_43",
              id: "notice_2",
              kind: "error",
              text: "Unknown command",
            },
          ]}
          notices={[]}
        />
      </ThemeProvider>,
    );

    expect(app.lastFrame()).toContain("error");
    expect(app.lastFrame()).toContain("Unknown command");
    expect(app.lastFrame()).not.toContain("command_43");
  });
});
