// @vitest-environment jsdom
import type { UiCurrentModelConfig, UiSettingsModels } from "ohbaby-sdk";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createMockSettingsApi } from "../../dev/mock-settings.js";
import { SettingsLayer } from "../../runtime/settings-layer.js";
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

it("refreshes the visible model label on external changes without opening its menu", async () => {
  const api = createMockSettingsApi("settings", () => Promise.resolve());
  const settings = new SettingsLayer(api, () => "/test");
  await render(
    <ModelMenu
      settings={settings}
      fallbackLabel=""
      missing={false}
      onManage={() => undefined}
      onError={() => undefined}
    />,
  );
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
  const settings = new SettingsLayer(
    {
      ...api,
      selectModel: async (id): Promise<UiSettingsModels> => {
        await held;
        return api.selectModel(id);
      },
    },
    () => "/test",
  );
  await render(
    <ModelMenu
      settings={settings}
      fallbackLabel=""
      missing={false}
      onManage={() => undefined}
      onError={() => undefined}
    />,
  );
  const trigger =
    document.querySelector<HTMLButtonElement>(".ohb-model-button");
  if (!trigger) throw new Error("Expected model button");
  act(() => {
    trigger.click();
  });
  const choice =
    document.querySelector<HTMLButtonElement>(
      "[role='menuitem'][aria-current='false']",
    ) ??
    document.querySelector<HTMLButtonElement>(
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
