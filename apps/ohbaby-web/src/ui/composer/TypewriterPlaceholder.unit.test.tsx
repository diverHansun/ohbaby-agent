// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSER_PLACEHOLDER_PHRASES,
  TypewriterPlaceholder,
} from "./TypewriterPlaceholder.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: {
  readonly container: HTMLDivElement;
  readonly root: Root;
}[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) {
    act(() => {
      app.root.unmount();
    });
    app.container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TypewriterPlaceholder", () => {
  it("types, pauses, deletes, and moves to the next phrase", () => {
    vi.useFakeTimers();
    const app = mountTypewriter({ active: true, phrases: ["Hi", "Bye"] });

    expect(app.container.textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(app.container.textContent).toBe("H");
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(app.container.textContent).toBe("Hi");
    act(() => {
      vi.advanceTimersByTime(1_400);
    });
    expect(app.container.textContent).toBe("H");
    act(() => {
      vi.advanceTimersByTime(32 + 400);
    });
    expect(app.container.textContent).toBe("B");
  });

  it("stops rendering and clears its timer when inactive", () => {
    vi.useFakeTimers();
    const app = mountTypewriter({ active: true, phrases: ["Hello"] });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(app.container.textContent).toBe("H");

    act(() => {
      app.root.render(
        <TypewriterPlaceholder active={false} phrases={["Hello"]} />,
      );
    });
    expect(app.container.textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(app.container.textContent).toBe("");
  });

  it("shows the complete first phrase when reduced motion is preferred", () => {
    const matchMedia = vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: true,
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);
    const app = mountTypewriter({ active: true });

    expect(app.container.textContent).toBe(COMPOSER_PLACEHOLDER_PHRASES[0]);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });
});

function mountTypewriter(
  props: React.ComponentProps<typeof TypewriterPlaceholder>,
): { readonly container: HTMLDivElement; readonly root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TypewriterPlaceholder {...props} />);
  });
  const app = { container, root };
  mounted.push(app);
  return app;
}
