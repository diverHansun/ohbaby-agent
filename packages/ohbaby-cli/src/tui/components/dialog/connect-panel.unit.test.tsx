import { render } from "ink-testing-library";
import type { CoreAPI, UiEventHandler } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { ConnectPanel } from "./connect-panel.js";

async function key(
  app: ReturnType<typeof render>,
  value: string,
): Promise<void> {
  app.stdin.write(value);
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("ConnectPanel protocols", () => {
  it("refreshes automatic evidence without replacing an in-progress override draft", async () => {
    let handler: UiEventHandler = () => undefined;
    let detected = 100000;
    const connectModel = vi.fn((_input: unknown) =>
      Promise.resolve({ saved: true }),
    );
    const client = {
      connectModel,
      getCurrentModel: vi.fn(() =>
        Promise.resolve({
          provider: "fixture",
          model: "model",
          baseUrl: "https://fixture.test/v1",
          interfaceProvider: "openai-compatible",
          detectedContextWindowTokens: detected,
          contextDiscovery: { status: "identified" },
          effectiveContextWindowTokens: detected,
          effectiveMaxOutputTokens: 32768,
        }),
      ),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        subscribeEvents={(next) => {
          handler = next;
          return (): void => undefined;
        }}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await until(() => (app.lastFrame() ?? "").includes("100000 tokens"));
    for (let index = 0; index < 5; index += 1) await key(app, "\u001b[B");
    await key(app, "\r");
    await key(app, "100000");
    detected = 200000;
    handler({ type: "model.invalidated" });
    await until(() => (app.lastFrame() ?? "").includes("200000 tokens"));
    expect(app.lastFrame()).toContain("100000");
    await key(app, "\r");
    expect(connectModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextWindowTokens: 100000 }),
    );
    app.unmount();
  });

  it("shows automatic capacity and cleanup notice without saving effective values", async () => {
    const connectModel = vi.fn((_input: unknown) =>
      Promise.resolve({ saved: true }),
    );
    const client = {
      connectModel,
      getCurrentModel: vi.fn(() =>
        Promise.resolve({
          provider: "fixture",
          model: "model",
          baseUrl: "https://fixture.test/v1",
          interfaceProvider: "anthropic",
          effectiveContextWindowTokens: 1000000,
          effectiveMaxOutputTokens: 32768,
          detectedContextWindowTokens: 1000000,
          contextDiscovery: {
            status: "identified",
            reason: "Latest lookup failed",
          },
          reasoningNotice: "unsupported-anthropic-effort-cleared",
        }),
      ),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await until(() => (app.lastFrame() ?? "").includes("fixture"));
    expect(app.lastFrame()).toContain("Automatic: 1000000 tokens");
    expect(app.lastFrame()).toContain("Latest lookup failed");
    expect(app.lastFrame()).toMatch(/Reasoning Effort.*cleared/);
    expect(app.lastFrame()).not.toContain("32768");
    await key(app, "\r");
    await key(app, "\r");
    expect(connectModel).not.toHaveBeenCalled();
    await key(app, "\r");
    await key(app, "2");
    await key(app, "\r");
    expect(connectModel).toHaveBeenCalledWith(
      expect.not.objectContaining({ contextWindowTokens: 1000000 }),
    );
    expect(connectModel.mock.calls[0]?.[0]).not.toHaveProperty(
      "maxOutputTokens",
    );
    app.unmount();
  });

  it("sends null when saved token overrides are cleared and preserves the other override", async () => {
    const connectModel = vi.fn((_input: unknown) =>
      Promise.resolve({ saved: true }),
    );
    const client = {
      connectModel,
      getCurrentModel: vi.fn(() =>
        Promise.resolve({
          provider: "fixture",
          model: "model",
          baseUrl: "https://fixture.test/v1",
          interfaceProvider: "openai-compatible",
          contextWindowTokens: 48000,
          maxOutputTokens: 4096,
          effectiveContextWindowTokens: 48000,
          effectiveMaxOutputTokens: 4096,
          contextDiscovery: { status: "unknown" },
        }),
      ),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await until(() => (app.lastFrame() ?? "").includes("fixture"));
    for (let index = 0; index < 5; index += 1) await key(app, "\u001b[B");
    await key(app, "\r");
    for (let index = 0; index < 5; index += 1) await key(app, "\b");
    await key(app, "\r");
    expect(connectModel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contextWindowTokens: null,
        maxOutputTokens: 4096,
      }),
    );
    await key(app, "\u001b[B");
    await key(app, "\r");
    for (let index = 0; index < 4; index += 1) await key(app, "\b");
    await key(app, "\r");
    expect(connectModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxOutputTokens: null }),
    );
    app.unmount();
  });

  it("shows a request-path warning before saving and still passes the URL through", async () => {
    const connectModel = vi.fn(() => Promise.resolve({ saved: true }));
    const client = {
      connectModel,
      getCurrentModel: vi.fn(() =>
        Promise.resolve({
          provider: "fixture",
          model: "model",
          baseUrl: "https://fixture.test/v1",
          interfaceProvider: "openai-compatible",
          contextWindowTokens: 8192,
          effectiveContextWindowTokens: 8192,
          effectiveMaxOutputTokens: 4096,
          contextDiscovery: { status: "unknown" },
        }),
      ),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await until(() =>
      (app.lastFrame() ?? "").includes("https://fixture.test/v1"),
    );
    app.stdin.write("\u001b[6~");
    await until(() => (app.lastFrame() ?? "").includes("> Base URL"));
    app.stdin.write("\r");
    await until(() => (app.lastFrame() ?? "").includes("[editing]"));
    app.stdin.write("/chat/completions");
    await until(() => (app.lastFrame() ?? "").includes("/chat/completions"));
    expect(app.lastFrame()).toMatch(/request path/i);
    app.stdin.write("\r");
    await until(() => connectModel.mock.calls.length === 1);
    expect(connectModel).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://fixture.test/v1/chat/completions",
      }),
    );
    app.unmount();
  });
  it("distinguishes selected and active edit rows without color, and keeps page navigation", async () => {
    const client = {
      connectModel: vi.fn(() => Promise.resolve({ saved: true })),
      getCurrentModel: vi.fn(() => Promise.resolve(null)),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await key(app, "");
    expect(app.lastFrame()).toContain("> Provider");
    expect(app.lastFrame()).not.toContain("[editing]");
    await key(app, "\r");
    expect(app.lastFrame()).toContain("[editing]");
    expect(app.lastFrame()).toContain("▏");
    await key(app, "fixture");
    await key(app, "\r");
    expect(app.lastFrame()).not.toContain("[editing]");
    await key(app, "\u001b[6~");
    expect(app.lastFrame()).toContain("> Base URL");
    await key(app, "\u001b[5~");
    expect(app.lastFrame()).toContain("> Provider");
    app.unmount();
  });

  it("masks an active secret edit while showing the caret", async () => {
    const client = {
      connectModel: vi.fn(() => Promise.resolve({ saved: true })),
      getCurrentModel: vi.fn(() => Promise.resolve(null)),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await key(app, "");
    for (let index = 0; index < 3; index += 1) await key(app, "\u001b[6~");
    await key(app, "\r");
    await key(app, "secret-fixture");
    expect(app.lastFrame()).toContain("**************▏");
    expect(app.lastFrame()).not.toContain("secret-fixture");
    app.unmount();
  });
  it("infers a missing protocol once when the initial URL is committed", async () => {
    const connectModel = vi.fn(() => Promise.resolve({ saved: true }));
    const client = {
      connectModel,
      getCurrentModel: vi.fn(() => Promise.resolve(null)),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await key(app, "");
    await key(app, "\r");
    await key(app, "fixture");
    await key(app, "\r");
    await key(app, "\u001B[B");
    await key(app, "\r");
    await key(app, "https://fixture.test/anthropic");
    await key(app, "\r");
    await key(app, "\r");
    await key(app, "/v1");
    await key(app, "\r");
    expect(app.lastFrame()).toContain("anthropic");
    // Replace the URL using backspaces, then commit a different URL.
    await key(app, "\r");
    for (const _character of "https://fixture.test/anthropic/v1")
      await key(app, "\b");
    await key(app, "https://fixture.test/v1");
    await key(app, "\r");
    for (let index = 0; index < 3; index += 1) await key(app, "\u001B[B");
    await key(app, "\r");
    await key(app, "model");
    await key(app, "\r");
    expect(connectModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ interfaceProvider: "anthropic" }),
    );
    app.unmount();
  });

  it("preserves Responses when editing another field and commits only protocol choices", async () => {
    const connectModel = vi.fn(() => Promise.resolve({ saved: true }));
    const client = {
      connectModel,
      getCurrentModel: vi.fn(() =>
        Promise.resolve({
          provider: "fixture",
          model: "model",
          baseUrl: "https://fixture.test/v1",
          interfaceProvider: "openai-responses",
          contextWindowTokens: 8192,
          effectiveContextWindowTokens: 8192,
          effectiveMaxOutputTokens: 4096,
          contextDiscovery: { status: "unknown" },
        }),
      ),
    } as unknown as CoreAPI;
    const app = render(
      <ConnectPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );
    await key(app, "");
    expect(app.lastFrame()).toContain("openai-responses");
    await key(app, "\r");
    await key(app, "2");
    await key(app, "\r");
    expect(connectModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ interfaceProvider: "openai-responses" }),
    );
    await key(app, "\u001B[A"); // appended protocol row
    await key(app, "\r");
    expect(app.lastFrame()).toContain("openai-compatible");
    expect(app.lastFrame()).toContain("openai-responses");
    expect(app.lastFrame()).toContain("anthropic");
    await key(app, "invalid-protocol");
    await key(app, "\u001B[B");
    await key(app, "\u001B"); // cancel
    expect(connectModel).toHaveBeenCalledTimes(1);
    await key(app, "\r");
    await key(app, "\u001B[B");
    await key(app, "\r");
    expect(connectModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ interfaceProvider: "anthropic" }),
    );
    expect(app.lastFrame()).not.toContain("invalid-protocol");
    app.unmount();
  });
});

async function until(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
