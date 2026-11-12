import { expect, it } from "vitest";
import { createLLMClientFromConfig } from "ohbaby-llm";
import { createRunModel } from "./run-model.js";
function client(
  window: number,
  output: number,
): ReturnType<typeof createLLMClientFromConfig> {
  return createLLMClientFromConfig({
    provider: "custom",
    model: "small",
    baseUrl: "https://model.example/v1",
    apiKey: "test",
    promptCache: "auto",
    interfaceProvider: "openai-compatible",
    maxTokens: output,
    contextWindowTokens: window,
  });
}
it("rejects a new run when output and safety reserve consume the context", () => {
  expect(() => createRunModel("small", client(32768, 32768))).toThrowError(
    /context/i,
  );
  let failure: unknown;
  try {
    createRunModel("small", client(16384, 32768));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE" });
});
it("uses a corrected budget and preserves the captured model instance", () => {
  const configured = client(16384, 4096);
  const first = createRunModel("small", configured);
  expect(first.tokenCounter.getBudget?.("small").inputBudgetTokens).toBe(11264);
  expect(createRunModel("small", configured)).toBe(first);
});
