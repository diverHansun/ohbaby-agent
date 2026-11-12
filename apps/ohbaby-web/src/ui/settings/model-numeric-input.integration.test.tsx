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

const entry: UiSettingsModel = {
  id: "numeric",
  provider: "custom",
  model: "numeric-model",
  baseUrl: "https://model.invalid/v1",
  interfaceProvider: "openai-compatible",
  apiKeyConfigured: false,
  configurationComplete: true,
  contextWindowTokens: 128000,
  maxOutputTokens: 4096,
  effectiveContextWindowTokens: 128000,
  effectiveMaxOutputTokens: 4096,
  contextDiscovery: { status: "unknown" },
  reasoning: { status: "unknown", efforts: [] },
};
const fields = [
  { label: "Context window", key: "contextWindowTokens" },
  { label: "Max output", key: "maxOutputTokens" },
] as const;

async function renderModelEditor(saved: UiSettingsModel = entry): Promise<{
  field(label: string): HTMLInputElement;
  save(): HTMLButtonElement;
  updateModel: Mock<SettingsLayer["updateModel"]>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const updateModel = vi
    .fn<SettingsLayer["updateModel"]>()
    .mockResolvedValue({ active: null, models: [] });
  const settings = { updateModel } as unknown as SettingsLayer;
  await act(async () => {
    root.render(
      <ModelEditor
        entry={saved}
        settings={settings}
        models={{ active: null, models: [saved] }}
        onBack={() => undefined}
        onSaved={() => undefined}
        onMissing={() => undefined}
      />,
    );
    await Promise.resolve();
  });
  const button = (label: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (control) => control.textContent.trim() === label,
    );
    if (!found) throw new Error(`Missing ${label} button`);
    return found;
  };
  await act(async () => {
    button("More options").click();
    await Promise.resolve();
  });
  const field = (label: string): HTMLInputElement => {
    const row = [...container.querySelectorAll("label")].find(
      (element) => element.firstChild?.textContent === label,
    );
    const control = row ? document.getElementById(row.htmlFor) : null;
    if (!(control instanceof HTMLInputElement))
      throw new Error(`Missing ${label} input`);
    return control;
  };
  const save = (): HTMLButtonElement => button("Save");
  return { field, save, updateModel };
}

/** Native input events carry the browser's raw typed or pasted value. */
async function input(control: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Use the native setter so React receives the controlled input event.
    const setter = descriptor?.set;
    if (!setter) throw new Error("Missing native value setter");
    Reflect.apply(setter, control, [value]);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}
async function clickSave(
  editor: Awaited<ReturnType<typeof renderModelEditor>>,
): Promise<void> {
  await act(async () => {
    editor.save().click();
    await Promise.resolve();
  });
}

it.each(fields)(
  "uses a text input with numeric keyboard and a positive integer pattern for $label",
  async ({ label }) => {
    const editor = await renderModelEditor();
    const control = editor.field(label);
    expect(control.type).toBe("text");
    expect(control.inputMode).toBe("numeric");
    expect(control.pattern).toBe("[1-9][0-9]*");
  },
);

it.each(
  fields.flatMap((field) =>
    ["-1", "0", "1.5", "1e3", "abc", "9007199254740992"].map((raw) => ({
      ...field,
      raw,
    })),
  ),
)(
  "keeps raw $raw visible in $label and blocks Save",
  async ({ label, raw }) => {
    const editor = await renderModelEditor();
    const control = editor.field(label);
    await input(control, raw);
    expect(control.value).toBe(raw);
    expect(control.getAttribute("aria-invalid")).toBe("true");
    const description = control.getAttribute("aria-describedby");
    expect(
      description && document.getElementById(description)?.textContent,
    ).toMatch(/whole number|too large/i);
    expect(editor.save().disabled).toBe(true);
    await clickSave(editor);
    expect(editor.updateModel).not.toHaveBeenCalled();
  },
);

it.each(fields)(
  "accepts 32768 in $label and submits a numeric override",
  async ({ label, key }) => {
    const editor = await renderModelEditor();
    await input(editor.field(label), "abc");
    expect(editor.save().disabled).toBe(true);
    await input(editor.field(label), "32768");
    expect(editor.field(label).value).toBe("32768");
    expect(editor.field(label).hasAttribute("aria-invalid")).toBe(false);
    expect(editor.save().disabled).toBe(false);
    await clickSave(editor);
    expect(editor.updateModel).toHaveBeenCalledTimes(1);
    expect(editor.updateModel).toHaveBeenCalledWith(entry.id, {
      [key]: 32768,
    });
  },
);

it.each(fields)(
  "permits empty $label and submits null to clear its saved override",
  async ({ label, key }) => {
    const editor = await renderModelEditor();
    await input(editor.field(label), "");
    expect(editor.field(label).value).toBe("");
    expect(editor.field(label).hasAttribute("aria-invalid")).toBe(false);
    expect(editor.save().disabled).toBe(false);
    await clickSave(editor);
    expect(editor.updateModel).toHaveBeenCalledTimes(1);
    expect(editor.updateModel).toHaveBeenCalledWith(entry.id, {
      [key]: null,
    });
  },
);

it("keeps both automatic numeric fields empty and omits them from an unrelated edit", async () => {
  const {
    contextWindowTokens: _context,
    maxOutputTokens: _output,
    ...automatic
  } = entry;
  const editor = await renderModelEditor(automatic);
  expect(editor.field("Context window").value).toBe("");
  expect(editor.field("Max output").value).toBe("");
  expect(editor.save().disabled).toBe(true);
  await input(editor.field("Label"), "Research");
  expect(editor.save().disabled).toBe(false);
  await clickSave(editor);
  expect(editor.updateModel).toHaveBeenCalledTimes(1);
  expect(editor.updateModel).toHaveBeenCalledWith(entry.id, {
    label: "Research",
  });
});

it.each(fields)(
  "associates the $label input with its visible label",
  async ({ label }) => {
    const editor = await renderModelEditor();
    const control = editor.field(label);
    expect(control.labels).toHaveLength(1);
    expect(control.labels?.[0].firstChild?.textContent).toBe(label);
    expect(control.getAttribute("aria-label")).toBeNull();
    expect(control.getAttribute("aria-labelledby")).toBeNull();
  },
);
