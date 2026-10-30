// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SidePanel } from "./SidePanel.js";
import { type SidePanelControls, useSidePanel } from "./use-side-panel.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "ohbaby.web.side-panel.v1";
const mounted: (() => void)[] = [];
let controls: SidePanelControls | undefined;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  controls = undefined;
});

function Harness(props: {
  readonly rootSessionId: string;
  readonly focusOnOpen?: boolean;
}): ReactElement {
  const panel = useSidePanel(props.rootSessionId);
  controls = panel;
  return panel.state.open ? (
    <SidePanel
      controls={panel}
      focusOnOpen={props.focusOnOpen}
      renderPage={(tab) => (
        <p data-testid="page">
          {tab.kind}:{tab.state.subagentId ?? "list"}
        </p>
      )}
    />
  ) : (
    <p data-testid="collapsed" />
  );
}

function mount(
  rootSessionId = "root",
  focusOnOpen = false,
): {
  readonly element: HTMLElement;
  readonly render: (rootSessionId: string) => void;
} {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (id: string): void => {
    act(() => {
      root.render(<Harness rootSessionId={id} focusOnOpen={focusOnOpen} />);
    });
  };
  render(rootSessionId);
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    element.remove();
  });
  return { element, render };
}

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new Error("missing element");
  act(() => {
    element.click();
  });
}

function button(scope: ParentNode, name: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll("button")].find(
      (item) =>
        item.getAttribute("aria-label") === name ||
        item.textContent.includes(name),
    ) ?? null
  );
}

it("starts closed with an entry page, opens Subagents tabs and offers only working pages", () => {
  const { element } = mount();
  expect(element.querySelector('[data-testid="collapsed"]')).not.toBeNull();
  act(() => {
    controls?.setOpen(true);
  });
  expect(element.textContent).toContain("Read and stop this chat's subagents");
  expect(element.querySelector('[role="tab"]')).toBeNull();

  click(button(element, "Subagents"));
  expect(element.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(element.querySelector('[data-testid="page"]')?.textContent).toBe(
    "subagents:list",
  );

  click(button(element, "Add page"));
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(["Subagents"]);
  click(items[0] ?? null);
  // A page kind is not a unique key (D36): the menu adds a second tab and selects it.
  const tabs = [...element.querySelectorAll('[role="tab"]')];
  expect(tabs).toHaveLength(2);
  expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
    "false",
    "true",
  ]);
});

it("keeps tabs and the open detail while collapsed, and returns to the entry page when the tab closes", () => {
  const { element } = mount();
  act(() => {
    controls?.openPage("subagents");
  });
  const tabId = controls?.state.tabs[0]?.id ?? "";
  act(() => {
    controls?.setTabState(tabId, "subagents", { subagentId: "reviewer" });
  });
  click(button(element, "Close side panel"));
  expect(element.querySelector('[data-testid="collapsed"]')).not.toBeNull();
  act(() => {
    controls?.setOpen(true);
  });
  expect(element.querySelector('[data-testid="page"]')?.textContent).toBe(
    "subagents:reviewer",
  );

  click(element.querySelector(".ohb-side-panel-tab-close"));
  expect(element.querySelector('[role="tab"]')).toBeNull();
  expect(element.textContent).toContain("Read and stop this chat's subagents");
});

it("moves between tabs with the arrow keys and closes the selected tab with Delete", () => {
  const { element } = mount();
  act(() => {
    controls?.openPage("subagents");
    controls?.openPage("subagents");
  });
  const tabs = [...element.querySelectorAll('[role="tab"]')];
  const first = tabs.at(0);
  const second = tabs.at(1);
  expect(first?.getAttribute("tabindex")).toBe("-1");
  expect(second?.getAttribute("tabindex")).toBe("0");
  expect(first?.hasAttribute("aria-controls")).toBe(false);
  act(() => {
    second?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(first?.getAttribute("aria-selected")).toBe("true");
  act(() => {
    first?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
  });
  expect(element.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(controls?.state.tabs).toHaveLength(1);
});

it("starts closed on a narrow window even when it was open before", () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, width: 500 }));
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("1023px"),
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  })) as unknown as typeof window.matchMedia;
  try {
    const { element } = mount();
    expect(element.querySelector('[data-testid="collapsed"]')).not.toBeNull();
    expect(controls?.state.width).toBe(500);
  } finally {
    window.matchMedia = original;
  }
});

it("moves focus into a panel the user opens so Escape reaches it on a narrow window", () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("1023px"),
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  })) as unknown as typeof window.matchMedia;
  try {
    const { element } = mount("root", true);
    act(() => {
      controls?.setOpen(true);
    });
    const entry = element.querySelector(".ohb-side-panel-entry button");
    expect(document.activeElement).toBe(entry);
    act(() => {
      entry?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(controls?.state.open).toBe(false);
  } finally {
    window.matchMedia = original;
  }
});

it("leaves focus alone for a panel that was not just opened by the user", () => {
  const { element } = mount();
  act(() => {
    controls?.setOpen(true);
  });
  expect(element.contains(document.activeElement)).toBe(false);
});

it("clears the selected instance when the primary session changes", () => {
  const { element, render } = mount("root-a");
  act(() => {
    controls?.openPage("subagents");
  });
  const tabId = controls?.state.tabs[0]?.id ?? "";
  act(() => {
    controls?.setTabState(tabId, "subagents", { subagentId: "reviewer" });
  });
  render("root-b");
  expect(element.querySelector('[data-testid="page"]')?.textContent).toBe(
    "subagents:list",
  );
});

it("opens a page straight into its state and expands over the chat until Escape", () => {
  const { element } = mount();
  act(() => {
    controls?.openPage("subagents", { subagentId: "reviewer" });
  });
  expect(element.querySelector('[data-testid="page"]')?.textContent).toBe(
    "subagents:reviewer",
  );
  click(button(element, "Expand side panel"));
  expect(controls?.state.expanded).toBe(true);
  const panel = element.querySelector("aside");
  act(() => {
    panel?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(controls?.state.expanded).toBe(false);
  expect(controls?.state.open).toBe(true);
  click(button(element, "Expand side panel"));
  click(button(element, "Close side panel"));
  act(() => {
    controls?.setOpen(true);
  });
  // Expanding is never remembered, even across a collapse.
  expect(controls?.state.expanded).toBe(false);
});

it("remembers only whether the panel is open and its width", () => {
  const { element } = mount();
  act(() => {
    controls?.openPage("subagents");
  });
  const handle = element.querySelector('[role="separator"]');
  if (!(handle instanceof HTMLElement)) throw new Error("missing handle");
  act(() => {
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
  });
  expect(controls?.state.width).toBe(444);
  act(() => {
    controls?.setWidth(10_000);
  });
  expect(controls?.state.width).toBe(720);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
    open: true,
    width: 720,
  });
});
