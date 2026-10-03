import { Text } from "ink";
import { render } from "ink-testing-library";
import type { CoreAPI, UiCurrentModelConfig, UiEventHandler } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { useFooterModel } from "./use-footer-model.js";

const model = (name: string): UiCurrentModelConfig => ({
  provider: "test",
  baseUrl: "https://example.test",
  interfaceProvider: "anthropic",
  model: name,
});
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));

describe("useFooterModel identity", () => {
  it("ignores late previous-session requests and refreshes only model events", async () => {
    const pending: ((model: UiCurrentModelConfig | null) => void)[] = [];
    const getCurrentModel = vi.fn(
      () =>
        new Promise<UiCurrentModelConfig | null>((resolve) =>
          pending.push(resolve),
        ),
    );
    const client = { getCurrentModel } as unknown as CoreAPI;
    let listener: UiEventHandler = () => undefined;
    const subscribe = (handler: UiEventHandler): (() => void) => {
      listener = handler;
      return () => undefined;
    };
    function View({ id }: { id: string }): React.ReactElement {
      const value = useFooterModel(client, id, subscribe);
      return <Text>{value?.model ?? "unknown"}</Text>;
    }
    const app = render(<View id="a" />);
    await tick();
    app.rerender(<View id="b" />);
    await tick();
    expect(app.lastFrame()).toBe("unknown");
    pending[1]?.(model("current"));
    await tick();
    pending[0]?.(model("stale"));
    await tick();
    expect(app.lastFrame()).toBe("current");
    app.rerender(<View id="b" />);
    await tick();
    expect(getCurrentModel).toHaveBeenCalledTimes(2);
    listener({
      type: "command.catalog.updated",
      version: "catalog-2",
      timestamp: 1,
    });
    await tick();
    expect(getCurrentModel).toHaveBeenCalledTimes(2);
    const frameCount = app.frames.length;
    listener({ type: "model.invalidated" });
    await tick();
    expect(app.lastFrame()).toBe("current");
    expect(app.frames.slice(frameCount).join("\n")).not.toContain("unknown");
    listener({ type: "model.invalidated" });
    await tick();
    pending[3]?.(model("newest"));
    await tick();
    pending[2]?.(model("obsolete"));
    await tick();
    expect(app.lastFrame()).toBe("newest");
    app.unmount();
  });
});
