// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiSettingsModel } from "ohbaby-sdk";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { ModelEditor } from "./ModelEditor.js";

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

const pendingEntry: UiSettingsModel = {
  id: "adaptive",
  provider: "custom",
  model: "adaptive-model",
  baseUrl: "https://model.invalid/v1",
  interfaceProvider: "anthropic",
  apiKeyConfigured: false,
  configurationComplete: true,
  effectiveContextWindowTokens: 300000,
  effectiveMaxOutputTokens: 32768,
  contextDiscovery: { status: "unknown" },
  reasoning: { status: "detecting", efforts: [] },
  reasoningDefault: { effort: "minimal" },
};

function cleanedEntry(): UiSettingsModel {
  const { reasoningDefault: _cleared, ...entry } = pendingEntry;
  return {
    ...entry,
    reasoningNotice: "unsupported-anthropic-effort-cleared",
    reasoning: {
      status: "identified",
      mode: "effort",
      efforts: ["low", "high"],
      supportsDisabled: true,
      default: { enabled: true, effort: "high" },
    },
  };
}

interface EditorHarness {
  readonly container: HTMLDivElement;
  readonly updateModel: Mock<SettingsLayer["updateModel"]>;
  readonly render: (entry: UiSettingsModel) => Promise<void>;
  readonly save: () => HTMLButtonElement;
  readonly field: (name: string) => HTMLInputElement | HTMLSelectElement;
}

function setup(): EditorHarness {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const updateModel = vi
    .fn<SettingsLayer["updateModel"]>()
    .mockResolvedValue({ active: null, models: [] });
  const settings = { updateModel } as unknown as SettingsLayer;
  const render = async (entry: UiSettingsModel): Promise<void> => {
    await act(async () => {
      root.render(
        <ModelEditor
          entry={entry}
          settings={settings}
          models={{ active: null, models: [entry] }}
          onBack={() => undefined}
          onSaved={() => undefined}
          onMissing={() => undefined}
        />,
      );
      await Promise.resolve();
    });
  };
  const save = (): HTMLButtonElement => {
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Save",
    );
    if (!button) throw new Error("Missing Save button");
    return button;
  };
  const field = (name: string): HTMLInputElement | HTMLSelectElement => {
    const label = [...container.querySelectorAll("label")].find(
      (element) => element.firstChild?.textContent === name,
    );
    const control = label ? document.getElementById(label.htmlFor) : null;
    if (
      !(control instanceof HTMLInputElement) &&
      !(control instanceof HTMLSelectElement)
    )
      throw new Error(`Missing ${name} field`);
    return control;
  };
  return { container, updateModel, render, save, field };
}

async function changeLabel(
  control: HTMLInputElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native setter in jsdom.
    const setter = descriptor?.set;
    if (setter) Reflect.apply(setter, control, [value]);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

it("keeps untouched Save disabled when discovery clears an incompatible default", async () => {
  const editor = setup();
  await editor.render(pendingEntry);
  expect(editor.save().disabled).toBe(true);
  await editor.render(cleanedEntry());
  expect(editor.container.textContent).toContain("minimal");
  expect(editor.save().disabled).toBe(true);
  expect(editor.updateModel).not.toHaveBeenCalled();
});

it("sends only the changed label after background cleanup, preserving its notice", async () => {
  const editor = setup();
  await editor.render(pendingEntry);
  await editor.render(cleanedEntry());
  await changeLabel(editor.field("Label") as HTMLInputElement, "Research");
  await act(async () => {
    editor.save().click();
    await Promise.resolve();
  });
  expect(editor.updateModel).toHaveBeenCalledTimes(1);
  expect(editor.updateModel).toHaveBeenCalledWith("adaptive", {
    label: "Research",
  });
  expect(editor.container.textContent).toContain("minimal");
});

it("still submits an explicit user reasoning selection after discovery", async () => {
  const editor = setup();
  await editor.render(pendingEntry);
  await editor.render(cleanedEntry());
  const select = editor.field("Reasoning Effort") as HTMLSelectElement;
  await act(async () => {
    select.value = "low";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    editor.save().click();
    await Promise.resolve();
  });
  expect(editor.updateModel).toHaveBeenCalledTimes(1);
  expect(editor.updateModel).toHaveBeenCalledWith("adaptive", {
    reasoning: { enabled: true, effort: "low" },
  });
});

it.each(["high", ""])(
  "shows an unavailable edited effort and blocks Save until the user selects %j",
  async (replacement) => {
    const editor = setup();
    const original: UiSettingsModel = {
      ...cleanedEntry(),
      reasoningNotice: undefined,
      reasoningDefault: { effort: "high" },
    };
    await editor.render(original);
    await changeLabel(editor.field("Label") as HTMLInputElement, "Research");
    const select = editor.field("Reasoning Effort") as HTMLSelectElement;
    await act(async () => {
      select.value = "low";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(editor.save().disabled).toBe(false);
    await editor.render({
      ...original,
      reasoning: { ...original.reasoning, efforts: ["high"] },
    });
    expect(select.value).toBe("low");
    expect(select.selectedOptions[0].textContent).toMatch(
      /low.*(?:unavailable|unsupported)/i,
    );
    expect(editor.save().disabled).toBe(true);
    await act(async () => {
      editor.save().click();
      await Promise.resolve();
    });
    expect(editor.updateModel).not.toHaveBeenCalled();
    await act(async () => {
      select.value = replacement;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(editor.save().disabled).toBe(false);
    await act(async () => {
      editor.save().click();
      await Promise.resolve();
    });
    expect(editor.updateModel).toHaveBeenCalledTimes(1);
    expect(editor.updateModel).toHaveBeenCalledWith(
      original.id,
      replacement === "high"
        ? { label: "Research" }
        : { label: "Research", reasoning: null },
    );
  },
);
