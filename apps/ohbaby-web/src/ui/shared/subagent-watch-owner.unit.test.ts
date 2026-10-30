import { describe, expect, it, vi } from "vitest";
import { createSubagentWatchCoordinator } from "./subagent-watch-owner.js";

describe("subagent watch owner", () => {
  it("tells every reader when the watch changes hands, once per change", () => {
    const watch = createSubagentWatchCoordinator();
    const listener = vi.fn();
    const unsubscribe = watch.subscribe(listener);
    expect(watch.owner()).toBeUndefined();
    watch.claim("panel");
    watch.claim("panel");
    watch.claim("sheet");
    expect(watch.owner()).toBe("sheet");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    watch.claim("panel");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
