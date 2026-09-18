import { render } from "ink-testing-library";
import type { CoreAPI } from "ohbaby-sdk";
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
    await key(app, "\u001b[6~");
    await key(app, "\r");
    await key(app, "/chat/completions");
    expect(app.lastFrame()).toMatch(/request path/i);
    await key(app, "\r");
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
