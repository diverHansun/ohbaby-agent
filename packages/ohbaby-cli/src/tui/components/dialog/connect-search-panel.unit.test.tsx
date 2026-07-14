import { render } from "ink-testing-library";
import type { CoreAPI, UiSetSearchApiKeyInput } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { ConnectSearchPanel } from "./connect-search-panel.js";

describe("ConnectSearchPanel", () => {
  it("does not show saved-to-env status for metadata-only saves", async () => {
    const save = deferred<Awaited<ReturnType<CoreAPI["setSearchApiKey"]>>>();
    const setSearchApiKey = vi.fn(
      (_input: UiSetSearchApiKeyInput) => save.promise,
    );
    const client = {
      setSearchApiKey,
    } as unknown as CoreAPI;
    const app = render(
      <ConnectSearchPanel
        client={client}
        onClose={vi.fn()}
        runtime={{ kind: "idle" }}
      />,
    );

    app.stdin.write("\r");
    app.stdin.write("\r");

    await until(() => setSearchApiKey.mock.calls.length === 1);
    await until(() => (app.lastFrame() ?? "").includes("saving"));
    save.resolve({
      apiKeyEnv: "TAVILY_API_KEY",
      envPath: "D:/home/.ohbaby/.env",
      provider: "tavily",
      searchJsonPath: "D:/home/.ohbaby/tools/search.json",
    });
    await until(() => !(app.lastFrame() ?? "").includes("saving"));

    expect(setSearchApiKey).toHaveBeenCalledWith({
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    });
    expect(app.lastFrame() ?? "").not.toContain("saved to");
    app.unmount();
  });
});

async function until(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for condition");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: resolveValue,
  };
}
