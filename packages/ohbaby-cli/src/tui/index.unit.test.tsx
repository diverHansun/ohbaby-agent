import { render } from "ink";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderTerminalUi } from "./index.js";

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  return {
    ...actual,
    render: vi.fn(() => ({}) as ReturnType<typeof render>),
  };
});

describe("renderTerminalUi", () => {
  beforeEach(() => {
    vi.mocked(render).mockClear();
  });

  it("enables incremental rendering to reduce terminal repaint flicker", () => {
    const unsubscribe = vi.fn();
    renderTerminalUi({
      client: {} as Parameters<typeof renderTerminalUi>[0]["client"],
      subscribeEvents: vi.fn(() => unsubscribe),
    });

    expect(render).toHaveBeenCalledWith(expect.anything(), {
      incrementalRendering: true,
    });
  });
});
