// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PermissionPolicyControl } from "./PermissionPolicyControl.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

it("closes on a second pointer click on the permission trigger", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onSetPermission = vi.fn();
  act(() => {
    root?.render(
      <PermissionPolicyControl
        level="default"
        disabled={false}
        onSetPermission={onSetPermission}
      />,
    );
  });
  const trigger = container.querySelector("button");
  if (!trigger) throw new Error("Permission trigger did not render");
  const clickTrigger = (): void => {
    // Separate browser events flush updates before the following click.
    act(() => {
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => {
      trigger.click();
    });
  };

  clickTrigger();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  clickTrigger();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(onSetPermission).not.toHaveBeenCalled();

  clickTrigger();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  act(() => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
