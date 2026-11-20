// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SessionLoading } from "./SessionLoading.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("SessionLoading", () => {
  it("announces the read and shows only the mark, no greeting", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(<SessionLoading />);
    });
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("Loading conversation…");
    expect(
      container.querySelector(
        '.ohb-session-loading-mark[aria-hidden="true"] .ohb-lychee-mark',
      ),
    ).not.toBeNull();
    expect(container.querySelector(".ohb-draft-greeting")).toBeNull();
    act(() => {
      root.unmount();
    });
  });
});
