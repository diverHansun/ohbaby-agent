// @vitest-environment jsdom
import type { UiSettingsModel, UiSettingsModels } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { SubagentModelRow } from "./SubagentModelRow.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function model(id: string, configurationComplete: boolean): UiSettingsModel {
  return {
    id,
    provider: "openai",
    model: `model-${id}`,
    apiKeyConfigured: configurationComplete,
    configurationComplete,
    effectiveContextWindowTokens: 128_000,
    effectiveMaxOutputTokens: 8_000,
    contextDiscovery: { status: "identified" },
    reasoning: { status: "unknown", efforts: [] },
  };
}

function mountRow(
  models: UiSettingsModels,
  onSetup: (id: string) => void,
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <SubagentModelRow
        settings={{} as SettingsLayer}
        models={models}
        onSetup={onSetup}
        onMissing={() => undefined}
      />,
    );
  });
  return container;
}

it("shows Needs setup for an incomplete subagent model and opens its editor", () => {
  const models: UiSettingsModels = {
    active: { id: "a", provider: "openai", model: "model-a" },
    subagent: {
      id: "b",
      provider: "openai",
      model: "model-b",
      configurationComplete: false,
    },
    models: [model("a", true), model("b", false)],
  };
  const onSetup = vi.fn();
  const container = mountRow(models, onSetup);
  const select = container.querySelector<HTMLSelectElement>(
    "select[aria-label='Subagent model']",
  );
  expect(select?.value).toBe("b");
  expect(select?.selectedOptions[0]?.textContent).toBe("model-b (needs setup)");
  const setup = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Needs setup",
  );
  act(() => {
    setup?.click();
  });
  expect(onSetup).toHaveBeenCalledWith("b");
});

it("shows the model entry's saved effort as the subagent model default", () => {
  const entry: UiSettingsModel = {
    ...model("a", true),
    reasoningDefault: { enabled: true, effort: "low" },
    reasoning: {
      status: "identified",
      mode: "effort",
      efforts: ["low", "medium", "high"],
      supportsDisabled: true,
      default: { enabled: true, effort: "medium" },
    },
  };
  const container = mountRow(
    {
      active: null,
      subagent: {
        id: entry.id,
        model: entry.model,
        provider: entry.provider,
        configurationComplete: true,
      },
      models: [entry],
    },
    vi.fn(),
  );
  const select = container.querySelector<HTMLSelectElement>(
    "select[aria-label='Subagent Reasoning Effort']",
  );
  expect(select?.selectedOptions[0]?.textContent).toBe("Model default (low)");
});
