import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { PrepareTurnInput } from "./index.js";

function compileLegacyPrepareInput(): PrepareTurnInput {
  return {
    directory: "/repo",
    modelId: "fake-model",
    sessionId: "session_1",
    toolNames: [],
    tools: undefined,
    // @ts-expect-error Batch C removed this ambiguous two-way request path.
    additionalMessages: [{ content: "legacy", role: "system" }],
  };
}

describe("prepared model request contract", () => {
  it("keeps the removed additionalMessages path out of production assembly", async () => {
    const sources = await Promise.all(
      [
        new URL("./types.ts", import.meta.url),
        new URL("./context-manager.ts", import.meta.url),
        new URL("../lifecycle/lifecycle.ts", import.meta.url),
      ].map((url) => readFile(url, "utf8")),
    );

    expect(sources.join("\n")).not.toContain("additionalMessages");
    expect(compileLegacyPrepareInput).toBeTypeOf("function");
  });
});
