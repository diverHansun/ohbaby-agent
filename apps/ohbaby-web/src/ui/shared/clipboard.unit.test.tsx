// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboard } from "./clipboard.js";
import { CopyButton } from "./CopyButton.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function stubClipboard(
  writeText: ((text: string) => Promise<void>) | null,
): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

function stubExecCommand(result: boolean | Error): ReturnType<typeof vi.fn> {
  const exec = vi.fn(() => {
    if (result instanceof Error) throw result;
    return result;
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: exec,
  });
  return exec;
}

afterEach(() => {
  stubClipboard(null);
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("writeClipboard", () => {
  it("uses the async clipboard when it works (T1)", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const exec = stubExecCommand(true);
    await expect(writeClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to a selection copy without a secure context (T2)", async () => {
    stubClipboard(null);
    let selected = "";
    const exec = vi.fn(() => {
      selected = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: exec,
    });
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    await expect(writeClipboard("a < b & c")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(selected).toBe("a < b & c");
    // The helper textarea is gone and focus is back where it was.
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("falls back when the async clipboard rejects, and reports a total failure (T2)", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    stubExecCommand(false);
    await expect(writeClipboard("x")).resolves.toBe(false);
    stubExecCommand(new Error("unsupported"));
    await expect(writeClipboard("x")).resolves.toBe(false);
  });
});

describe("CopyButton", () => {
  async function render(
    text: string,
    ok: boolean,
  ): Promise<{ button: HTMLButtonElement; close: () => void }> {
    stubClipboard(ok ? (): Promise<void> => Promise.resolve() : null);
    stubExecCommand(false);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async (): Promise<void> => {
      root.render(<CopyButton label="Copy message" text={() => text} />);
      await Promise.resolve();
    });
    const button = container.querySelector("button");
    if (!button) throw new Error("no button");
    return {
      button,
      close: (): void => {
        act(() => {
          root.unmount();
        });
      },
    };
  }

  it("shows Copied, then returns to its label", async () => {
    vi.useFakeTimers();
    const { button, close } = await render("hi", true);
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button.getAttribute("aria-label")).toBe("Copied");
    expect(button.dataset.copyState).toBe("copied");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button.getAttribute("aria-label")).toBe("Copy message");
    close();
  });

  it("says Copy failed instead of pretending (T2)", async () => {
    const { button, close } = await render("hi", false);
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(button.dataset.copyState).toBe("failed");
    close();
  });
});
