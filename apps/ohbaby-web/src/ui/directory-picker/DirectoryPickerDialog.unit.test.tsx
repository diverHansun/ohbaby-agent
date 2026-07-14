// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectoryPickerDialog,
  type DirectoryPickerApi,
} from "./DirectoryPickerDialog.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { container: HTMLDivElement; root: Root }[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) {
    act(() => {
      app.root.unmount();
    });
    app.container.remove();
  }
  vi.restoreAllMocks();
});

function mount(input: {
  readonly directoryPicker: DirectoryPickerApi;
  readonly onClose?: () => void;
  readonly onSelect?: (directory: string) => Promise<void>;
}): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(
      <DirectoryPickerDialog
        directoryPicker={input.directoryPicker}
        onClose={input.onClose ?? ((): void => undefined)}
        onSelect={input.onSelect ?? ((): Promise<void> => Promise.resolve())}
      />,
    );
  });
  return container;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for condition");
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function directoryPicker(): DirectoryPickerApi & {
  readonly getDirectoryPickerRoots: ReturnType<
    typeof vi.fn<DirectoryPickerApi["getDirectoryPickerRoots"]>
  >;
  readonly listDirectoryPicker: ReturnType<
    typeof vi.fn<DirectoryPickerApi["listDirectoryPicker"]>
  >;
} {
  const getDirectoryPickerRoots = vi.fn<
    DirectoryPickerApi["getDirectoryPickerRoots"]
  >(() =>
    Promise.resolve({
      ok: true,
      roots: [{ directory: "C:\\", name: "C:\\" }],
    }),
  );
  const listDirectoryPicker = vi.fn<DirectoryPickerApi["listDirectoryPicker"]>(
    (directory) =>
      Promise.resolve(
        directory === "C:\\"
          ? {
              children: [{ directory: "C:\\Projects", name: "Projects" }],
              directory,
              ok: true,
              parent: null,
            }
          : {
              children: [],
              directory,
              ok: true,
              parent: "C:\\",
            },
      ),
  );
  return { getDirectoryPickerRoots, listDirectoryPicker };
}

describe("DirectoryPickerDialog", () => {
  it("loads roots and navigates into a child directory", async () => {
    const picker = directoryPicker();
    const container = mount({ directoryPicker: picker });

    await waitFor(() => container.textContent.includes("C:\\"));
    const root = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("root button not found");
    }
    await click(root);
    await waitFor(() => container.textContent.includes("Projects"));

    const child = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Projects"),
    );
    if (!child) {
      throw new Error("child button not found");
    }
    await click(child);
    await waitFor(() => container.textContent.includes("C:\\Projects"));
    expect(picker.listDirectoryPicker).toHaveBeenCalledWith("C:\\");
    expect(picker.listDirectoryPicker).toHaveBeenCalledWith("C:\\Projects");
  });

  it("returns to the parent supplied by the server", async () => {
    const picker = directoryPicker();
    const container = mount({ directoryPicker: picker });
    await waitFor(() => container.textContent.includes("C:\\"));

    const root = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("root button not found");
    }
    await click(root);
    await waitFor(() => container.textContent.includes("Projects"));
    const child = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Projects"),
    );
    if (!child) {
      throw new Error("child button not found");
    }
    await click(child);
    await waitFor(() => container.textContent.includes("C:\\Projects"));

    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Back",
    );
    if (!back) {
      throw new Error("back button not found");
    }
    await click(back);
    await waitFor(() => picker.listDirectoryPicker.mock.calls.length === 3);
    expect(picker.listDirectoryPicker).toHaveBeenLastCalledWith("C:\\");
  });

  it("returns to the root locations from the breadcrumb", async () => {
    const picker = directoryPicker();
    const container = mount({ directoryPicker: picker });
    await waitFor(() => container.textContent.includes("C:\\"));

    const root = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("root button not found");
    }
    await click(root);
    await waitFor(() => container.textContent.includes("Projects"));

    const locations = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Locations",
    );
    if (!locations) {
      throw new Error("locations button not found");
    }
    await click(locations);
    await waitFor(() => picker.getDirectoryPickerRoots.mock.calls.length === 2);

    expect(container.textContent).not.toContain("Projects");
    expect(container.textContent).not.toContain("Choose this folder");
  });

  it("selects the current directory without calculating a new path", async () => {
    const picker = directoryPicker();
    const onSelect = vi.fn<(directory: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const container = mount({ directoryPicker: picker, onSelect });
    await waitFor(() => container.textContent.includes("C:\\"));
    const root = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("root button not found");
    }
    await click(root);
    await waitFor(() => container.textContent.includes("Choose this folder"));

    const choose = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Choose this folder",
    );
    if (!choose) {
      throw new Error("choose button not found");
    }
    await click(choose);
    expect(onSelect).toHaveBeenCalledWith("C:\\");
  });

  it("cannot close the dialog while opening a selected directory", async () => {
    let resolveSelection: (() => void) | undefined;
    const selection = new Promise<void>((resolve) => {
      resolveSelection = resolve;
    });
    const onClose = vi.fn();
    const onSelect = vi.fn<(directory: string) => Promise<void>>(
      () => selection,
    );
    const container = mount({
      directoryPicker: directoryPicker(),
      onClose,
      onSelect,
    });
    await waitFor(() => container.textContent.includes("C:\\"));

    const root = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("root button not found");
    }
    await click(root);
    await waitFor(() => container.textContent.includes("Choose this folder"));
    const choose = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Choose this folder",
    );
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    const close = container.querySelector<HTMLButtonElement>(
      '[aria-label="Close directory picker"]',
    );
    const layer = container.querySelector(".ohb-directory-picker-layer");
    if (!choose || !cancel || !close || !layer) {
      throw new Error("directory picker controls not found");
    }
    await act(async () => {
      choose.click();
      choose.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => choose.textContent === "Opening…");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(close.disabled).toBe(true);

    await act(async () => {
      cancel.click();
      layer.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveSelection?.();
      await selection;
    });
  });

  it("closes without selecting when cancelled or escaped", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn<(directory: string) => Promise<void>>();
    const container = mount({
      directoryPicker: directoryPicker(),
      onClose,
      onSelect,
    });
    await waitFor(() => container.textContent.includes("C:\\"));
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    if (!cancel) {
      throw new Error("cancel button not found");
    }
    await act(async () => {
      cancel.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a recoverable directory listing error", async () => {
    const picker = directoryPicker();
    picker.listDirectoryPicker.mockRejectedValueOnce(
      new Error("Access denied"),
    );
    const container = mount({ directoryPicker: picker });
    await waitFor(() => container.textContent.includes("C:\\"));
    const root = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("root button not found");
    }
    await click(root);
    await waitFor(() => container.textContent.includes("Access denied"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Access denied",
    );
    expect(container.textContent).toContain("Retry");
  });
});
