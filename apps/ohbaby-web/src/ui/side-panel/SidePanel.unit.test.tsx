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
          {tab.kind}:
          {(tab.kind === "subagents" ? tab.state.subagentId : undefined) ??
            "list"}
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
  expect(items.map((item) => item.textContent)).toEqual([
    "Subagents",
    "Files",
    "Terminal",
    "Side chat",
  ]);
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

/** Lays the tabs out 100px wide in DOM order inside a 300px strip. */
function layOutTabs(element: HTMLElement): HTMLElement[] {
  const list = element.querySelector<HTMLElement>('[role="tablist"]');
  if (!list) throw new Error("missing tab list");
  list.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 300, 28);
  const tabs = [...list.querySelectorAll<HTMLElement>("[data-side-tab]")];
  for (const tab of tabs) {
    tab.getBoundingClientRect = (): DOMRect =>
      new DOMRect([...list.children].indexOf(tab) * 100, 0, 100, 28);
  }
  return tabs;
}

/** jsdom has no PointerEvent; React reads these fields from any event. */
function pointer(target: EventTarget, type: string, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

function tabOrder(): string[] {
  return controls?.state.tabs.map((tab) => tab.id) ?? [];
}

it("drags the selected tab past a neighbour's middle without remounting its page", () => {
  const { element } = mount();
  act(() => {
    controls?.openPage("subagents");
    controls?.openPage("subagents");
    controls?.openPage("subagents");
  });
  const [first, second, third] = tabOrder();
  const tabs = layOutTabs(element);
  const dragged = tabs[2]?.querySelector('[role="tab"]');
  if (!dragged) throw new Error("missing tab");
  const page = element.querySelector('[data-testid="page"]');

  pointer(dragged, "pointerdown", 250);
  // Less than 4px is still a click.
  pointer(window, "pointermove", 252);
  expect(tabs[2]?.classList.contains("is-dragging")).toBe(false);
  // Its middle (190) has not crossed the second tab's (150) yet.
  pointer(window, "pointermove", 190);
  expect(tabOrder()).toEqual([first, second, third]);
  expect(tabs[2]?.style.transform).toBe("translateX(-60px)");
  pointer(window, "pointermove", 140);
  expect(tabOrder()).toEqual([first, third, second]);
  // Still under the pointer after taking the second slot at 100px.
  expect(tabs[2]?.style.transform).toBe("translateX(-10px)");
  pointer(window, "pointerup", 140);

  expect(tabs[2]?.classList.contains("is-dragging")).toBe(false);
  expect(tabs[2]?.style.transform).toBe("");
  expect(controls?.state.activeTabId).toBe(third);
  expect(element.querySelector('[data-testid="page"]')).toBe(page);
  expect(document.activeElement).toBe(dragged);
});

it("selects a tab once it is dragged, keeps it in the strip and never drags from close", () => {
  const { element } = mount();
  act(() => {
    controls?.openPage("subagents");
    controls?.openPage("subagents");
  });
  const [first, second] = tabOrder();
  const tabs = layOutTabs(element);
  const close = tabs[0]?.querySelector(".ohb-side-panel-tab-close");
  const tab = tabs[0]?.querySelector('[role="tab"]');
  if (!close || !tab) throw new Error("missing tab controls");

  pointer(close, "pointerdown", 80);
  pointer(window, "pointermove", 180);
  pointer(window, "pointerup", 180);
  expect(tabOrder()).toEqual([first, second]);
  expect(controls?.state.activeTabId).toBe(second);

  pointer(tab, "pointerdown", 50);
  pointer(window, "pointermove", 60);
  expect(controls?.state.activeTabId).toBe(first);
  expect(tabs[0]?.classList.contains("is-dragging")).toBe(true);
  // Far past the strip's end, it stops at the last slot.
  pointer(window, "pointermove", 900);
  expect(tabOrder()).toEqual([second, first]);
  expect(tabs[0]?.style.transform).toBe("translateX(100px)");
  pointer(window, "pointerup", 900);
  expect(tabs[0]?.classList.contains("is-dragging")).toBe(false);
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

it("reveals a page from elsewhere in the selected tab of that kind, or a new one", () => {
  const { element } = mount();
  act(() => {
    controls?.revealPage("subagents", { subagentId: "reviewer" });
  });
  expect(controls?.state.open).toBe(true);
  expect(controls?.state.tabs).toHaveLength(1);
  act(() => {
    controls?.openPage("subagents");
  });
  act(() => {
    controls?.revealPage("subagents", { subagentId: "writer" });
  });
  // The selected (second) tab is reused; no third tab appears.
  expect(
    controls?.state.tabs.map((tab) =>
      tab.kind === "subagents" ? tab.state.subagentId : undefined,
    ),
  ).toEqual(["reviewer", "writer"]);
  // Only the selected tab's page is mounted, so one subagent reader at most.
  expect(element.querySelectorAll('[data-testid="page"]')).toHaveLength(1);
  expect(element.querySelector('[data-testid="page"]')?.textContent).toBe(
    "subagents:writer",
  );
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

it("resizes from the visible width with the keyboard when the chat limits the panel", () => {
  const { element } = mount();
  act(() => {
    controls?.setOpen(true);
    controls?.setWidth(720);
  });
  element.className = "ohb-shell";
  const main = document.createElement("main");
  main.className = "ohb-shell-main";
  main.style.setProperty("--main-min-width", "400px");
  element.prepend(main);
  const panel = element.querySelector("aside");
  const handle = element.querySelector('[role="separator"]');
  if (!panel || !handle) throw new Error("missing panel or resize handle");
  const shownWidth = (): number => Math.min(controls?.state.width ?? 720, 532);
  panel.getBoundingClientRect = (): DOMRect =>
    new DOMRect(0, 0, shownWidth(), 600);
  main.getBoundingClientRect = (): DOMRect =>
    new DOMRect(0, 0, 932 - shownWidth(), 600);

  const press = (key: string): void => {
    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    });
  };
  press("ArrowRight");
  expect(controls?.state.width).toBe(508);
  press("ArrowLeft");
  expect(controls?.state.width).toBe(532);
  press("ArrowLeft");
  expect(controls?.state.width).toBe(532);
  press("ArrowRight");
  expect(controls?.state.width).toBe(508);
});
