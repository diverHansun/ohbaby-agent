import { render } from "ink-testing-library";
import type { CoreAPI } from "ohbaby-sdk";
import { expect, it, vi } from "vitest";
import { EffortPanel } from "./effort-panel.js";

it("keeps identified choices visible alongside a failed retry reason and cleanup notice", async () => {
  const client = {
    getCurrentModel: vi.fn(() =>
      Promise.resolve({
        reasoning: {
          status: "identified",
          mode: "effort",
          efforts: ["low", "high"],
          reason: "Latest probe timed out",
        },
        reasoningNotice: "unsupported-anthropic-effort-cleared",
      }),
    ),
  } as unknown as CoreAPI;
  const app = render(
    <EffortPanel
      client={client}
      sessionId={null}
      pendingReasoning={null}
      onSelect={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain("high");
  });
  expect(app.lastFrame()).toContain("Latest probe timed out");
  expect(app.lastFrame()).toMatch(/Reasoning Effort.*cleared/);
  app.unmount();
});
