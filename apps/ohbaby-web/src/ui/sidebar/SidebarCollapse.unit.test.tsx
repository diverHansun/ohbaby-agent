// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarCollapse } from "./SidebarCollapse.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function render(open: boolean, variant: "section" | "group" = "group"): void {
  act(() => {
    root.render(
      <SidebarCollapse open={open} variant={variant}>
        <div className="child-row">Chat A</div>
      </SidebarCollapse>,
    );
  });
}

function collapseEl(): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>(".ohb-collapse");
}

function mockHeight(element: HTMLElement, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    bottom: height,
    height,
    left: 0,
    right: 200,
    toJSON: () => ({}),
    top: 0,
    width: 200,
    x: 0,
    y: 0,
  });
}

function mockReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

function dispatchTransitionEnd(target: Element, propertyName: string): void {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  act(() => {
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockReducedMotion(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("renders nothing when initially closed and settled open when initially open", () => {
  render(false, "group");
  expect(collapseEl()).toBeNull();

  render(true, "section");
  // Opening from closed enters first; unmount and mount fresh as initially open.
  act(() => {
    root.unmount();
  });
  root = createRoot(container);
  render(true, "section");

  const el = collapseEl();
  expect(el).not.toBeNull();
  expect(el?.className).toBe("ohb-collapse ohb-collapse-section is-open");
  expect(el?.hasAttribute("inert")).toBe(false);
  expect(container.querySelector(".child-row")?.textContent).toBe("Chat A");
});

it("animates open across frames and clears is-animating after grid-template-rows finishes", () => {
  render(false, "group");
  expect(collapseEl()).toBeNull();

  render(true, "group");
  const el = collapseEl();
  expect(el).not.toBeNull();
  expect(el?.classList.contains("ohb-collapse-group")).toBe(true);
  expect(el?.classList.contains("is-open")).toBe(false);
  expect(el?.classList.contains("is-animating")).toBe(true);
  expect(el?.hasAttribute("inert")).toBe(false);

  // Two animation frames move from 0fr entering state to 1fr opening state.
  act(() => {
    vi.advanceTimersByTime(40);
  });
  expect(el?.classList.contains("is-open")).toBe(true);
  expect(el?.classList.contains("is-animating")).toBe(true);

  // Unrelated property transitions or bubbled child transitions do not settle it early.
  const child = container.querySelector(".child-row");
  if (!child || !el) throw new Error("Missing elements");
  dispatchTransitionEnd(child, "grid-template-rows");
  dispatchTransitionEnd(el, "opacity");
  expect(el.classList.contains("is-animating")).toBe(true);

  dispatchTransitionEnd(el, "grid-template-rows");
  expect(el.classList.contains("is-open")).toBe(true);
  expect(el.classList.contains("is-animating")).toBe(false);
});

it("keeps children mounted and inert while closing, then unmounts on transitionend", () => {
  render(true, "section");
  const el = collapseEl();
  if (!el) throw new Error("Missing collapse element");
  mockHeight(el, 120);

  render(false, "section");
  expect(collapseEl()).toBe(el);
  expect(el.classList.contains("is-open")).toBe(false);
  expect(el.classList.contains("is-animating")).toBe(true);
  expect(el.hasAttribute("inert")).toBe(true);
  expect(container.querySelector(".child-row")).not.toBeNull();

  // Ignoring opacity keeps it mounted until grid-template-rows finishes.
  dispatchTransitionEnd(el, "opacity");
  expect(collapseEl()).toBe(el);

  dispatchTransitionEnd(el, "grid-template-rows");
  expect(collapseEl()).toBeNull();
});

it("unmounts via fallback timer if transitionend never fires", () => {
  render(true, "group");
  const el = collapseEl();
  if (!el) throw new Error("Missing collapse element");
  mockHeight(el, 80);

  render(false, "group");
  expect(collapseEl()).toBe(el);

  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(collapseEl()).toBeNull();
});

it("reverses cleanly when reopened mid-close without remounting children", () => {
  render(true, "group");
  const el = collapseEl();
  const child = container.querySelector(".child-row");
  if (!el || !child) throw new Error("Missing elements");
  mockHeight(el, 96);

  render(false, "group");
  expect(el.classList.contains("is-open")).toBe(false);
  expect(el.hasAttribute("inert")).toBe(true);

  render(true, "group");
  expect(collapseEl()).toBe(el);
  expect(container.querySelector(".child-row")).toBe(child);
  expect(el.classList.contains("is-open")).toBe(true);
  expect(el.classList.contains("is-animating")).toBe(true);
  expect(el.hasAttribute("inert")).toBe(false);

  // Old closing fallback timer must not unmount the reopened panel.
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(collapseEl()).toBe(el);
  expect(el.classList.contains("is-open")).toBe(true);
  expect(el.classList.contains("is-animating")).toBe(false);
});

it("opens and closes immediately without waiting when reduced motion is enabled or height is zero", () => {
  mockReducedMotion(true);
  render(false, "group");
  render(true, "group");
  const el = collapseEl();
  expect(el?.classList.contains("is-open")).toBe(true);
  expect(el?.classList.contains("is-animating")).toBe(false);

  if (el) mockHeight(el, 120);
  render(false, "group");
  expect(collapseEl()).toBeNull();

  // Even without reduced motion, a zero-height element (e.g. jsdom default) unmounts immediately.
  mockReducedMotion(false);
  render(true, "section");
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(collapseEl()).not.toBeNull();
  render(false, "section");
  expect(collapseEl()).toBeNull();
});

it("unmounts cleanly when closed mid-entering before opening frames run", () => {
  render(false, "group");
  render(true, "group");
  expect(collapseEl()?.classList.contains("is-open")).toBe(false);

  render(false, "group");
  expect(collapseEl()).toBeNull();

  // Advancing timers must not resurrect the panel from a stale rAF.
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(collapseEl()).toBeNull();
});
