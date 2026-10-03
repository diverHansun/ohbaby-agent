import { render } from "ink-testing-library";
import type { CoreAPI } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import { Prompt } from "./index.js";
import { LayoutProvider } from "../../layout/context.js";
import { computeLayoutMetrics } from "../../layout/metrics.js";
import { visibleWidth } from "../../render/wrap.js";

describe("prompt two-line footer", () => {
  it.each([120, 80, 60])(
    "renders a light input boundary and current facts at %i columns",
    (columns) => {
      const layout = computeLayoutMetrics({ columns, rows: 24 });
      const app = render(
        <LayoutProvider value={layout}>
          <Prompt
            activeSessionId="session-must-not-leak"
            catalog={null}
            client={{} as CoreAPI}
            disabled={false}
            projectRoot="/workspace/❤️/中文项目"
            model={{
              provider: "test",
              baseUrl: "https://example.test",
              interfaceProvider: "anthropic",
              model: "chosen-model",
              reasoning: {
                status: "identified",
                mode: "effort",
                efforts: ["high"],
              },
            }}
            reasoning={{ effort: "high" }}
            permission={{ mode: "auto", level: "default", sessionRules: [] }}
            contextWindowUsage="0.2% 2k/1m"
          />
        </LayoutProvider>,
      );
      const frame = app.lastFrame() ?? "";
      const rows = frame.split("\n");
      expect(rows.at(-2)).toMatch(/auto\/default$/);
      expect(rows.at(-1)).toMatch(/chosen-model · high\s+0.2% 2k\/1m$/);
      expect(
        rows.every((row) => visibleWidth(row) <= layout.contentWidth),
      ).toBe(true);
      expect(frame).not.toMatch(
        /session-must-not-leak|effort|Permission|Context|╭|╰/,
      );
      expect(frame).toContain("─");
      app.unmount();
    },
  );
});
