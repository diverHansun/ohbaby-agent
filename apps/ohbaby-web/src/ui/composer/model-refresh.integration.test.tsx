// @vitest-environment jsdom
import type { UiCurrentModelConfig } from "ohbaby-sdk";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createMockSettingsApi } from "../../dev/mock-settings.js";
import { SettingsLayer } from "../../runtime/settings-layer.js";
import { useSettingsModels } from "./model-choice.js";
import { ModelMenu } from "./ModelMenu.js";
import { useReasoning, type ReasoningClient } from "./useReasoning.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

async function render(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
}

type MenuProps = Parameters<typeof ModelMenu>[0];

/** The menu as the session screen mounts it, reading the shared list. */
function MenuHarness(props: Omit<MenuProps, "models">): ReactElement {
  const models = useSettingsModels(props.settings);
  return <ModelMenu {...props} models={models} />;
}

function menu(
  settings: SettingsLayer,
  overrides: Partial<Omit<MenuProps, "models">> = {},
): ReactElement {
  return (
    <MenuHarness
      settings={settings}
      selectedEntryId={undefined}
      onSelect={() => Promise.resolve()}
      fallbackLabel=""
      missing={false}
      onManage={() => undefined}
      onError={() => undefined}
      {...overrides}
    />
  );
}

function openMenu(): HTMLButtonElement {
  const trigger =
    document.querySelector<HTMLButtonElement>(".ohb-model-button");
  if (!trigger) throw new Error("Expected model button");
  act(() => {
    trigger.click();
  });
  return trigger;
}

function row(model: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".ohb-model-menu-list [role='menuitem']",
    ),
  ].find((item) => item.textContent.includes(model));
  if (!found) throw new Error(`Expected a row for ${model}`);
  return found;
}

it("refreshes the visible model label on external changes without opening its menu", async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  const settings = new SettingsLayer(api, () => "/test");
  await render(menu(settings));
  const before = document.querySelector(".ohb-model-button")?.textContent;
  const models = await api.getModels();
  const other = models.models.find(
    (model) => model.configurationComplete && model.id !== models.active?.id,
  );
  if (!other) throw new Error("Expected another configured model");
  await api.selectModel(other.id);
  await act(async () => {
    settings.invalidate(["model"]);
    await new Promise((resolve) => setTimeout(resolve, 70));
  });
  expect(document.querySelector(".ohb-model-button")?.textContent).not.toBe(
    before,
  );
  expect(document.querySelector(".ohb-model-button")?.textContent).toContain(
    other.model,
  );
});

it("refreshes thinking on focus and tab visibility when there was no event", async () => {
  let model: UiCurrentModelConfig | null = null;
  const client: ReasoningClient = {
    getCurrentModel: () => Promise.resolve(model),
    subscribeEvents: () => () => undefined,
    updateSessionReasoning: vi.fn(),
  };
  function Control(): ReactElement {
    const state = useReasoning(client, null, () => undefined);
    return <div>{state.kind}</div>;
  }
  await render(<Control />);
  expect(document.body.textContent).toBe("hidden");
  model = {
    id: "test-model",
    source: "default",
    provider: "local",
    baseUrl: "http://127.0.0.1:9/v1",
    interfaceProvider: "openai-compatible",
    model: "reasoning",
    contextWindowTokens: 32000,
    reasoning: {
      status: "identified",
      mode: "effort",
      efforts: ["low", "high"],
      supportsDisabled: false,
      default: { enabled: true, effort: "low" },
    },
  };
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(document.body.textContent).toBe("choice");
  model = null;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(document.body.textContent).toBe("hidden");
});

it("does not start another model choice while the previous save is pending", async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settings = new SettingsLayer(api, () => "/test");
  await render(menu(settings, { onSelect: () => held }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const trigger = openMenu();
  const choice = document.querySelector<HTMLButtonElement>(
    "[role='group'] [role='menuitem']:not([aria-current])",
  );
  if (!choice) throw new Error("Expected another model choice");
  act(() => {
    choice.click();
  });
  act(() => {
    trigger.click();
  });
  try {
    expect(document.querySelector("[role='menu']")).toBeNull();
  } finally {
    await act(async () => {
      release();
      await held;
    });
  }
});

it("keeps a chat's own model when the default changes, and tags the default", async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  const settings = new SettingsLayer(api, () => "/test");
  const onSelect = vi.fn(() => Promise.resolve());
  await render(menu(settings, { selectedEntryId: "m3", onSelect }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(document.querySelector(".ohb-model-button")?.textContent).toContain(
    "gpt-5.2",
  );
  await api.selectModel("m5");
  await act(async () => {
    settings.invalidate(["model"]);
    await new Promise((resolve) => setTimeout(resolve, 70));
  });
  expect(document.querySelector(".ohb-model-button")?.textContent).toContain(
    "gpt-5.2",
  );
  openMenu();
  expect(row("gpt-5.2").getAttribute("aria-current")).toBe("true");
  expect(
    row("claude-sonnet-5-5").querySelector(".ohb-model-default-tag"),
  ).not.toBeNull();
  expect(row("gpt-5.2").querySelector(".ohb-model-default-tag")).toBeNull();
  // Incomplete entries are not offered.
  expect(document.body.textContent).not.toContain("gpt-4.1");
  act(() => {
    row("claude-sonnet-5-5").click();
  });
  expect(onSelect).toHaveBeenCalledWith("m5");
});

it("pins a chat that follows the default when the default is picked", async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  const settings = new SettingsLayer(api, () => "/test");
  const onSelect = vi.fn(() => Promise.resolve());
  await render(menu(settings, { onSelect }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  openMenu();
  const current = document.querySelector<HTMLButtonElement>(
    ".ohb-model-menu-list [aria-current='true']",
  );
  act(() => {
    current?.click();
  });
  expect(onSelect).toHaveBeenCalledWith("m1");
});

it("restores the previous label and reports a failed choice", async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  const settings = new SettingsLayer(api, () => "/test");
  const onError = vi.fn();
  await render(
    menu(settings, {
      selectedEntryId: "m2",
      onSelect: () => Promise.reject(new Error("Model entry not found")),
      onError,
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  openMenu();
  await act(async () => {
    row("gpt-5.2").click();
    await Promise.resolve();
  });
  expect(onError).toHaveBeenCalledOnce();
  expect(document.querySelector(".ohb-model-button")?.textContent).toContain(
    "deepseek-v4.1-pro",
  );
});

it("reads a draft's thinking from its chosen entry and falls back to the entry default", async () => {
  const client: ReasoningClient = {
    getCurrentModel: () => Promise.resolve(null),
    subscribeEvents: () => () => undefined,
    updateSessionReasoning: vi.fn(),
  };
  const first = (
    await createMockSettingsApi("settings", () => Promise.resolve()).getModels()
  ).models.at(0);
  if (!first) throw new Error("Expected a model");
  const entry = {
    ...first,
    reasoning: {
      status: "identified" as const,
      mode: "effort" as const,
      efforts: ["low", "medium", "high"],
      supportsDisabled: true,
      default: { enabled: true, effort: "medium" },
    },
    reasoningDefault: { enabled: true, effort: "high" },
  };
  function Control(): ReactElement {
    const state = useReasoning(client, null, () => undefined, entry);
    return <div>{state.kind === "choice" ? state.value : state.kind}</div>;
  }
  await render(<Control />);
  expect(document.body.textContent).toBe("high");
});

it("switches back to the chat's model while the first switch awaits its echo", async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  const settings = new SettingsLayer(api, () => "/test");
  const onSelect = vi.fn(() => Promise.resolve());
  await render(menu(settings, { selectedEntryId: "m2", onSelect }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  openMenu();
  await act(async () => {
    row("gpt-5.2").click();
    await Promise.resolve();
  });
  expect(document.querySelector(".ohb-model-button")?.textContent).toContain(
    "gpt-5.2",
  );
  openMenu();
  await act(async () => {
    row("deepseek-v4.1-pro").click();
    await Promise.resolve();
  });
  expect(onSelect).toHaveBeenLastCalledWith("m2");
  expect(document.querySelector(".ohb-model-button")?.textContent).toContain(
    "deepseek-v4.1-pro",
  );
});
