// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../dev/mock-runtime.js";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { selectSettings } from "../../store/settings-cache.js";
import { OhbabyWebApp } from "../App.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

function mount(runtime: OhbabyWebRuntime): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<OhbabyWebApp runtime={runtime} />);
  });
  return container;
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".ohb-settings-dialog");
  if (!element) throw new Error("settings dialog not found");
  return element;
}

function dialogOpen(): boolean {
  const layer = document.querySelector<HTMLElement>(".ohb-settings-layer");
  return layer !== null && !layer.hidden;
}

/** A disclosure or editable row by its visible name. */
function row(name: string): HTMLButtonElement {
  const found = [
    ...dialog().querySelectorAll<HTMLButtonElement>(".ohb-settings-row-main"),
  ].find(
    (candidate) =>
      candidate.querySelector(".ohb-settings-row-title")?.textContent === name,
  );
  if (!found) throw new Error(`row not found: ${name}`);
  return found;
}

function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent.trim() === name,
  );
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const labelElement = [...dialog().querySelectorAll("label")].find(
    (candidate) => candidate.firstChild?.textContent === label,
  );
  const id = labelElement?.htmlFor;
  const control = id ? document.getElementById(id) : null;
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLSelectElement)
  )
    throw new Error(`field not found: ${label}`);
  return control;
}

async function type(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  await act(async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native setter in jsdom.
    const setValue = descriptor?.set;
    if (setValue) Reflect.apply(setValue, control, [value]);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function key(target: Element, name: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
    await Promise.resolve();
  });
}

async function openSettings(
  container: HTMLElement,
): Promise<HTMLButtonElement> {
  const gear = button(container, "Settings");
  await click(gear);
  await until(dialogOpen, "the settings dialog");
  return gear;
}

describe("settings dialog", () => {
  it("opens from the gear, keeps the URL, closes on Escape and returns focus", async () => {
    const runtime = createMockRuntime("settings");
    const container = mount(runtime);
    const url = location.href;
    const gear = await openSettings(container);

    const nav = [
      ...dialog().querySelectorAll<HTMLButtonElement>(".ohb-settings-nav-item"),
    ].map((item) => item.textContent.trim());
    expect(nav).toEqual(["Models", "MCP", "Skills", "Web search", "About"]);
    expect(
      dialog().querySelector("[aria-current='page']")?.textContent,
    ).toContain("Models");
    expect(document.activeElement?.textContent).toContain("Models");
    expect(document.querySelector(".ohb-shell")?.hasAttribute("inert")).toBe(
      true,
    );
    await until(
      () => dialog().textContent.includes("deepseek-v4.1-flash"),
      "the model list",
    );
    expect(dialog().textContent).toContain("Default");
    expect(dialog().textContent).toContain("Needs setup");

    // A click on the scrim does not close it.
    const scrim = document.querySelector<HTMLElement>(".ohb-settings-scrim");
    if (scrim) await click(scrim);
    expect(dialogOpen()).toBe(true);

    await key(dialog(), "Escape");
    expect(dialogOpen()).toBe(false);
    expect(document.activeElement).toBe(gear);
    expect(location.href).toBe(url);
  });

  it("remembers an unsaved edit across close and drops it on a section switch", async () => {
    const runtime = createMockRuntime("settings");
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => dialog().textContent.includes("gpt-5.2"),
      "the model list",
    );
    await click(button(dialog(), "Edit gpt-5.2"));
    await type(field("Label") as HTMLInputElement, "Draft label");
    await click(button(dialog(), "Close settings"));
    await openSettings(container);
    expect((field("Label") as HTMLInputElement).value).toBe("Draft label");

    await click(button(dialog(), "Web search"));
    await click(button(dialog(), "Models"));
    await until(
      () => dialog().textContent.includes("Add model"),
      "the model list",
    );
    expect(dialog().querySelector(".ohb-settings-editor")).toBeNull();
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "opens chat search with %s+K after settings closes",
    async (modifier) => {
      const runtime = createMockRuntime("settings");
      const container = mount(runtime);
      await openSettings(container);
      await click(button(dialog(), "Close settings"));
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            bubbles: true,
            [modifier]: true,
          }),
        );
        await Promise.resolve();
      });
      const search = container.querySelector(
        'input[aria-label="Search chats"]',
      );
      expect(search).not.toBeNull();
      expect(document.activeElement).toBe(search);
    },
  );

  it("keeps a model edit's original baseline when settings refresh", async () => {
    const runtime = createMockRuntime("settings");
    const update = vi.spyOn(runtime.settings, "updateModel");
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => dialog().textContent.includes("gpt-5.2"),
      "the model list",
    );
    await click(button(dialog(), "Edit gpt-5.2"));
    await type(field("Label") as HTMLInputElement, "My edit");
    await act(async () => {
      await runtime.settings.updateModel("m3", {
        baseUrl: "https://changed-elsewhere.test/v1",
      });
    });
    update.mockClear();
    await click(button(dialog(), "Save"));
    expect(update).toHaveBeenCalledWith("m3", { label: "My edit" });
    await until(
      () => dialog().querySelector(".ohb-settings-editor") === null,
      "the list after saving",
    );
    const saved = selectSettings(
      runtime.settings.cache.getSnapshot(),
      "models",
    ).data?.models.find((model) => model.id === "m3");
    expect(saved?.baseUrl).toBe("https://changed-elsewhere.test/v1");
  });

  it("locks model edits and Back while saving, while settings can still close", async () => {
    const runtime = createMockRuntime("settings");
    const originalUpdate = runtime.settings.updateModel.bind(runtime.settings);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(runtime.settings, "updateModel").mockImplementationOnce(
      async (id, patch) => {
        await pending;
        return originalUpdate(id, patch);
      },
    );
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => dialog().textContent.includes("gpt-5.2"),
      "the model list",
    );
    await click(button(dialog(), "Edit gpt-5.2"));
    await type(field("Label") as HTMLInputElement, "Saved label");
    await click(button(dialog(), "Save"));
    expect(field("Label").matches(":disabled")).toBe(true);
    expect(button(dialog(), "Replace").matches(":disabled")).toBe(true);
    expect(button(dialog(), "Back to Models").disabled).toBe(true);
    await click(button(dialog(), "Close settings"));
    expect(dialogOpen()).toBe(false);
    await act(async () => {
      release?.();
      await pending;
    });
    await openSettings(container);
    await until(
      () => dialog().querySelector(".ohb-settings-editor") === null,
      "the list after saving",
    );
    expect(dialog().textContent).toContain("Saved label");
  });

  it("keeps a key reference added elsewhere while completing model setup", async () => {
    const runtime = createMockRuntime("settings");
    const update = vi.spyOn(runtime.settings, "updateModel");
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => dialog().textContent.includes("gpt-4.1"),
      "the model list",
    );
    await click(button(dialog(), "Edit gpt-4.1"));
    await type(field("Base URL") as HTMLInputElement, "https://model.test/v1");
    await act(async () => {
      const protocol = field("Protocol") as HTMLSelectElement;
      protocol.value = "openai-compatible";
      protocol.dispatchEvent(new Event("change", { bubbles: true }));
      await runtime.settings.updateModel("m4", {
        apiKeyEnv: "ADDED_ELSEWHERE_KEY",
      });
    });
    expect(
      selectSettings(
        runtime.settings.cache.getSnapshot(),
        "models",
      ).data?.models.find((model) => model.id === "m4")?.configurationComplete,
    ).toBe(false);
    update.mockClear();
    await click(button(dialog(), "Save"));
    expect(update).toHaveBeenCalledWith("m4", {
      baseUrl: "https://model.test/v1",
      interfaceProvider: "openai-compatible",
    });
    await until(
      () => dialog().querySelector(".ohb-settings-editor") === null,
      "the list after completing setup",
    );
    expect(
      selectSettings(
        runtime.settings.cache.getSnapshot(),
        "models",
      ).data?.models.find((model) => model.id === "m4")?.apiKeyEnv,
    ).toBe("ADDED_ELSEWHERE_KEY");
  });

  it("sends only changed fields and clears a label with null", async () => {
    const runtime = createMockRuntime("settings");
    const update = vi.spyOn(runtime.settings, "updateModel");
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => dialog().textContent.includes("deepseek-v4.1-flash"),
      "the model list",
    );
    await click(button(dialog(), "Edit deepseek-v4.1-flash Work"));
    const save = button(dialog(), "Save");
    expect(save.disabled).toBe(true);
    await type(field("Label") as HTMLInputElement, "");
    await click(button(dialog(), "Replace"));
    await type(field("API key") as HTMLInputElement, "sk-test-secret");
    expect(save.disabled).toBe(false);
    await click(save);
    await until(
      () => dialog().querySelector(".ohb-settings-editor") === null,
      "the list after saving",
    );
    expect(update).toHaveBeenCalledWith("m1", {
      label: null,
      apiKey: "sk-test-secret",
    });
    // Focus lands on the edited row, so Escape still closes the dialog.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Edit deepseek-v4.1-flash",
    );
    await key(dialog(), "Escape");
    expect(dialogOpen()).toBe(false);
    expect(document.body.textContent).not.toContain("sk-test-secret");
  });

  it("blocks saving a cleared value that has no clear protocol", async () => {
    const runtime = createMockRuntime("settings");
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => dialog().textContent.includes("gpt-5.2"),
      "the model list",
    );
    await click(button(dialog(), "Edit gpt-5.2"));
    await click(button(dialog(), "More options"));
    await type(field("Max output") as HTMLInputElement, "");
    expect(button(dialog(), "Save").disabled).toBe(true);
    expect(dialog().textContent).toContain("This can't be cleared");
    await click(button(dialog(), "Restore"));
    expect((field("Max output") as HTMLInputElement).value).toBe("32000");
  });

  it("asks before deleting the default model but not another one", async () => {
    const runtime = createMockRuntime("settings");
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => dialog().textContent.includes("deepseek-v4.1-pro"),
      "the model list",
    );
    await click(button(dialog(), "deepseek-v4.1-pro actions"));
    await click(button(document.body, "Delete"));
    await until(
      () => !dialog().textContent.includes("deepseek-v4.1-pro"),
      "the deleted row",
    );
    expect(document.querySelector(".ohb-confirm-dialog")).toBeNull();

    await click(button(dialog(), "deepseek-v4.1-flash actions"));
    await click(button(document.body, "Delete"));
    const confirm = document.querySelector<HTMLElement>(".ohb-confirm-dialog");
    expect(confirm?.textContent).toContain("Delete deepseek-v4.1-flash?");
    expect(confirm?.textContent).toContain(
      "The next available model becomes the default.",
    );
    expect(document.activeElement?.textContent).toBe("Cancel");
    // Escape closes the confirmation only.
    if (confirm) await key(confirm, "Escape");
    expect(document.querySelector(".ohb-confirm-dialog")).toBeNull();
    expect(dialogOpen()).toBe(true);
  });

  it("puts a server field error under its input and keeps the input", async () => {
    const runtime = createMockRuntime("settings-errors");
    const container = mount(runtime);
    await openSettings(container);
    await until(
      () => !button(dialog(), "Add model").disabled,
      "the model list",
    );
    await click(button(dialog(), "Add model"));
    await type(field("Provider") as HTMLInputElement, "acme");
    await type(field("Model") as HTMLInputElement, "acme-1");
    await type(field("Base URL") as HTMLInputElement, "https://acme.test/v1");
    await click(button(dialog(), "Save"));
    await until(
      () => dialog().textContent.includes("Has an invalid format"),
      "the field error",
    );
    const model = field("Model");
    expect(model.value).toBe("acme-1");
    expect(model.getAttribute("aria-invalid")).toBe("true");
  });

  it("returns to the draft once a model added from a send becomes the default", async () => {
    const runtime = createMockRuntime("settings-empty");
    const container = mount(runtime);
    const composer = container.querySelector("textarea");
    if (!composer) throw new Error("composer not found");
    await type(composer, "hello there");
    await click(button(container, "Send message"));
    await until(dialogOpen, "the dialog opened by sending");
    expect(
      dialog().querySelector("[aria-current='page']")?.textContent,
    ).toContain("Models");
    await until(
      () => dialog().textContent.includes("No models yet."),
      "the empty list",
    );
    await click(button(dialog(), "Add model"));
    await type(field("Provider") as HTMLInputElement, "acme");
    await type(field("Model") as HTMLInputElement, "acme-1");
    await type(field("Base URL") as HTMLInputElement, "https://acme.test/v1");
    await click(button(dialog(), "Save"));
    await until(() => !dialogOpen(), "the dialog to close");
    expect(
      selectSettings(runtime.settings.cache.getSnapshot(), "models").data
        ?.active?.provider,
    ).toBe("acme");
    expect(container.querySelector("textarea")?.value).toBe("hello there");
  });

  it("saves a Web search key without echoing it", async () => {
    const runtime = createMockRuntime("settings-empty");
    const update = vi.spyOn(runtime.settings, "updateSearch");
    const container = mount(runtime);
    await openSettings(container);
    await click(button(dialog(), "Web search"));
    await until(
      () => dialog().textContent.includes("Not set"),
      "the search form",
    );
    await click(button(dialog(), "Add key"));
    await type(field("API key") as HTMLInputElement, "tvly-secret");
    await click(button(dialog(), "Save"));
    await until(
      () => dialog().textContent.includes("Configured"),
      "the saved key",
    );
    expect(update).toHaveBeenCalledWith({ apiKey: "tvly-secret" });
    expect(document.body.textContent).not.toContain("tvly-secret");
    expect(button(dialog(), "Save").disabled).toBe(true);
  });

  it("keeps a search edit's original baseline when settings refresh", async () => {
    const runtime = createMockRuntime("settings");
    const update = vi.spyOn(runtime.settings, "updateSearch");
    const container = mount(runtime);
    await openSettings(container);
    await click(button(dialog(), "Web search"));
    await until(
      () => dialog().textContent.includes("Configured"),
      "the search form",
    );
    await click(button(dialog(), "More options"));
    await type(field("Timeout") as HTMLInputElement, "120");
    await act(async () => {
      await runtime.settings.updateSearch({
        baseUrl: "https://changed-elsewhere.test/search",
      });
    });
    update.mockClear();
    await click(button(dialog(), "Save"));
    expect(update).toHaveBeenCalledWith({ defaults: { timeout: 120 } });
    await until(
      () => !field("Timeout").matches(":disabled"),
      "the saved search form",
    );
    expect(field("Base URL").value).toBe(
      "https://changed-elsewhere.test/search",
    );
  });

  it("locks search edits while saving and unlocks them after the response", async () => {
    const runtime = createMockRuntime("settings");
    const originalUpdate = runtime.settings.updateSearch.bind(runtime.settings);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(runtime.settings, "updateSearch").mockImplementationOnce(
      async (patch) => {
        await pending;
        return originalUpdate(patch);
      },
    );
    const container = mount(runtime);
    await openSettings(container);
    await click(button(dialog(), "Web search"));
    await until(
      () => dialog().textContent.includes("Configured"),
      "the search form",
    );
    await click(button(dialog(), "More options"));
    await type(field("Timeout") as HTMLInputElement, "120");
    await click(button(dialog(), "Save"));
    expect(field("Timeout").matches(":disabled")).toBe(true);
    expect(button(dialog(), "Replace").matches(":disabled")).toBe(true);
    await act(async () => {
      release?.();
      await pending;
    });
    await until(() => !field("Timeout").matches(":disabled"), "the saved form");
    expect(field("Timeout").value).toBe("120");
    expect(button(dialog(), "Save").disabled).toBe(true);
  });

  it("shows MCP config with the actual status and never writes", async () => {
    const runtime = createMockRuntime("settings");
    const container = mount(runtime);
    const reads = vi.spyOn(runtime.settings, "load");
    await openSettings(container);
    await click(button(dialog(), "MCP"));
    await until(
      () => dialog().textContent.includes("3 tools"),
      "the MCP status",
    );
    const rows = [...dialog().querySelectorAll(".ohb-settings-row")].map(
      (row) => row.textContent,
    );
    expect(rows).toEqual([
      "github3 tools",
      "filesystemFailed",
      "docs-searchOff",
    ]);
    await click(row("filesystem"));
    expect(dialog().textContent).toContain("spawn mcp-filesystem ENOENT");
    await click(row("docs-search"));
    // Header and env values never reach the page, only their names.
    expect(dialog().textContent).toContain("Authorization");
    // No inputs, switches or write buttons in the section.
    expect(
      dialog().querySelectorAll(".ohb-settings-content input"),
    ).toHaveLength(0);
    expect(dialog().textContent).not.toMatch(
      /Save|Delete|Reconnect|Add server/u,
    );
    reads.mockClear();
    await click(button(dialog(), "Refresh"));
    expect(reads.mock.calls.map(([kind]) => kind).sort()).toEqual([
      "mcpServers",
      "mcpStatus",
    ]);
  });

  it("keeps the MCP config when the status read fails", async () => {
    const runtime = createMockRuntime("settings-errors");
    const container = mount(runtime);
    await openSettings(container);
    await click(button(dialog(), "MCP"));
    await until(
      () =>
        dialog().textContent.includes("Couldn't read the connection status."),
      "the status failure",
    );
    expect(dialog().textContent).toContain("github—");
    expect(button(dialog(), "Retry")).toBeDefined();
  });

  it("lists only global skills and leaves out absent About items", async () => {
    const runtime = createMockRuntime("settings");
    const container = mount(runtime);
    await openSettings(container);
    await click(button(dialog(), "Skills"));
    await until(() => dialog().textContent.includes("humanizer"), "skills");
    expect(dialog().textContent).not.toContain("project-only");
    await click(row("humanizer"));
    expect(dialog().textContent).toContain(
      "/Users/demo/.ohbaby/skills/humanizer/SKILL.md",
    );
    await click(button(dialog(), "About"));
    await until(() => dialog().textContent.includes("0.1.16"), "About");
    expect(dialog().textContent).toContain("Diagnostics file");
  });
});

describe("composer controls", () => {
  it("switches the global default from the model menu", async () => {
    const runtime = createMockRuntime("settings");
    const select = vi.spyOn(runtime.settings, "selectModel");
    const container = mount(runtime);
    const trigger = (): HTMLButtonElement => {
      const element =
        container.querySelector<HTMLButtonElement>(".ohb-model-button");
      if (!element) throw new Error("model button not found");
      return element;
    };
    await until(
      () => trigger().textContent === "deepseek-v4.1-flash",
      "the label",
    );
    await click(trigger());
    const menu = document.querySelector<HTMLElement>(".ohb-model-menu");
    if (!menu) throw new Error("model menu not found");
    const items = [...menu.querySelectorAll("[role='menuitem']")].map(
      (item) => item.textContent,
    );
    // Only complete models, and Manage models… last.
    expect(items).not.toContain("gpt-4.1");
    expect(items.at(-1)).toBe("Manage models…");
    await click(button(menu, "claude-sonnet-5-5 · Personal"));
    await until(
      () =>
        trigger().textContent === "claude-sonnet-5-5" && !trigger().disabled,
      "the new default",
    );
    expect(select).toHaveBeenCalledWith("m5");
    expect(container.textContent).not.toMatch(/next turn|default model/iu);

    select.mockRejectedValueOnce(new Error("offline"));
    await click(trigger());
    const again = document.querySelector<HTMLElement>(".ohb-model-menu");
    if (!again) throw new Error("model menu not found");
    await click(button(again, "gpt-5.2"));
    await until(
      () =>
        document.body.textContent.includes(
          "Couldn't switch the model. offline",
        ),
      "the failure notice",
    );
    expect(trigger().textContent).toBe("claude-sonnet-5-5");
  });

  it("puts thinking and full access in the phone More menu", async () => {
    const runtime = createMockRuntime("settings");
    const container = mount(runtime);
    const more = button(container, "More controls");
    await click(more);
    const menu = document.querySelector<HTMLElement>(".ohb-menu");
    if (!menu) throw new Error("More menu not found");
    const fullAccess = button(menu, "Full access: off");
    await click(fullAccess);
    expect(document.body.textContent).toContain("Enable full access?");
    await click(button(document.body, "Not now"));
    await until(() => document.activeElement === more, "focus back on More");
  });

  it("opens Thinking options in place and returns to the first level", async () => {
    const base = createMockRuntime("running");
    const mock = base.client;
    if (!mock) throw new Error("mock client missing");
    const updates: unknown[] = [];
    const client = new Proxy(mock, {
      get(target, key, receiver): unknown {
        if (key === "getCurrentModel")
          return () =>
            Promise.resolve({
              provider: "p",
              model: "m",
              baseUrl: "https://p.test",
              interfaceProvider: "openai-compatible",
              reasoning: {
                status: "identified",
                mode: "effort",
                supportsDisabled: true,
                efforts: ["low", "high"],
                default: { enabled: true, effort: "low" },
              },
            });
        if (key === "updateSessionReasoning")
          return (input: { reasoning: unknown }) => {
            updates.push(input.reasoning);
            return new Promise(() => undefined);
          };
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const runtime: OhbabyWebRuntime = { ...base, client };
    const container = mount(runtime);
    await until(
      () => container.querySelector("[aria-label='Reasoning effort']") !== null,
      "the reasoning capability",
    );
    await click(button(container, "More controls"));
    const menu = (): HTMLElement => {
      const element = document.querySelector<HTMLElement>(".ohb-menu");
      if (!element) throw new Error("menu not found");
      return element;
    };
    await click(button(menu(), "Thinking: low"));
    expect(button(menu(), "Thinking").className).toContain("ohb-menu-back");
    await click(button(menu(), "high"));
    expect(updates).toEqual([{ enabled: true, effort: "high" }]);
    // Back on the first level, with the draft untouched.
    expect(button(menu(), "Thinking: high")).toBeDefined();
    await key(menu(), "Escape");
    expect(document.querySelector(".ohb-menu")).toBeNull();
  });
});
