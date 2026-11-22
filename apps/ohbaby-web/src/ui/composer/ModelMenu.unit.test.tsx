// @vitest-environment jsdom
import type { UiSettingsModels } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockSettingsApi } from "../../dev/mock-settings.js";
import { SettingsLayer } from "../../runtime/settings-layer.js";
import { ModelMenu } from "./ModelMenu.js";
import type { ReasoningState } from "./useReasoning.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let settings: SettingsLayer;
let models: UiSettingsModels;

beforeEach(async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  settings = new SettingsLayer(api, () => "/test");
  models = await api.getModels();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

type Choice = Extract<ReasoningState, { kind: "choice" }>;

function choice(overrides: Partial<Choice> = {}): Choice {
  return {
    kind: "choice",
    value: "high",
    options: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ],
    select: vi.fn(),
    ...overrides,
  };
}

function render(
  reasoning: ReasoningState,
  list: UiSettingsModels = models,
): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ModelMenu
        settings={settings}
        models={list}
        selectedEntryId={list.models[0]?.id}
        onSelect={() => Promise.resolve()}
        fallbackLabel=""
        missing={false}
        onManage={() => undefined}
        onError={() => undefined}
        reasoning={reasoning}
      />,
    );
  });
}

function trigger(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(".ohb-model-button");
  if (!button) throw new Error("Model button missing");
  return button;
}

function click(element: HTMLElement | null | undefined): void {
  if (!element) throw new Error("Element missing");
  act(() => {
    element.click();
  });
}

function escape(): void {
  const menu = document.querySelector(".ohb-menu");
  if (!menu) throw new Error("Menu missing");
  act(() => {
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

function effortRow(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "[role='menuitem'][aria-label^='Effort']",
  );
}

it("A-1: shows the model name and a dim, capitalised effort", () => {
  render(choice());
  const effort = trigger().querySelector(".ohb-model-button-effort");
  expect(effort?.textContent).toBe("High");
  expect(trigger().textContent).toContain(models.models[0]?.model ?? "");
  expect(trigger().title).toBe(
    `Model and reasoning effort for this chat: ${models.models[0]?.model ?? ""}, High`,
  );
});

it("A-2: a model without reasoning shows only its name and no Effort row", () => {
  render({ kind: "hidden" });
  expect(document.querySelector(".ohb-model-button-effort")).toBeNull();
  click(trigger());
  expect(effortRow()).toBeNull();
  expect(document.body.textContent).toContain("Manage models");
});

it("A-4: drills into Effort, marks the current level and closes after a choice", () => {
  const select = vi.fn();
  render(choice({ select }));
  click(trigger());
  const row = effortRow();
  expect(row?.getAttribute("aria-label")).toBe("Effort, High");
  click(row);
  const current = document.querySelector("[aria-current='true']");
  expect(current?.textContent).toBe("High");
  expect(current?.querySelector(".ohb-menu-check")).not.toBeNull();
  const low = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
  ).find((item) => item.textContent === "Low");
  click(low);
  expect(select).toHaveBeenCalledWith("low");
  expect(document.querySelector(".ohb-menu")).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it("A-5: Esc and the back row return to the root; Esc at the root closes", () => {
  render(choice());
  click(trigger());
  click(effortRow());
  expect(document.querySelector(".ohb-menu-back")).not.toBeNull();
  escape();
  expect(effortRow()).not.toBeNull();
  click(effortRow());
  click(document.querySelector<HTMLButtonElement>(".ohb-menu-back"));
  expect(effortRow()).not.toBeNull();
  escape();
  expect(document.querySelector(".ohb-menu")).toBeNull();
});

it("A-7: the filter never hides the Effort row or Manage models", () => {
  const first = models.models.at(0);
  if (!first) throw new Error("Expected a model");
  const many: UiSettingsModels = {
    ...models,
    models: Array.from({ length: 10 }, (_, index) => ({
      ...first,
      id: `m-${String(index)}`,
      model: `model-${String(index)}`,
      configurationComplete: true,
    })),
  };
  render(choice(), many);
  click(trigger());
  const filter = document.querySelector<HTMLInputElement>(".ohb-menu-filter");
  if (!filter) throw new Error("Filter missing");
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    if (!descriptor?.set) throw new Error("Missing input value setter");
    descriptor.set.call(filter, "model-3");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const visibleRows = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".ohb-model-menu-list [role='menuitem']",
    ),
  ).filter((item) => !item.hidden);
  expect(visibleRows.map((item) => item.textContent)).toEqual([
    expect.stringContaining("model-3"),
  ]);
  expect(effortRow()?.hidden).toBe(false);
  const manage = Array.from(
    document.querySelectorAll<HTMLElement>("[role='menuitem']"),
  ).find((item) => item.textContent.includes("Manage models"));
  expect(manage?.hidden).toBe(false);
});

it("A-8: a save error shows under the Effort row and turns the effort red", () => {
  render(choice({ error: "Couldn't save Reasoning Effort." }));
  expect(
    trigger().querySelector(".ohb-model-button-effort.is-error"),
  ).not.toBeNull();
  click(trigger());
  const alert = document.querySelector("[role='alert']");
  expect(alert?.textContent).toBe("Couldn't save Reasoning Effort.");
  expect(effortRow()?.getAttribute("aria-invalid")).toBe("true");
});
