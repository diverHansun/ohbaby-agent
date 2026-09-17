import { describe, expect, expectTypeOf, it } from "vitest";
import { inferConnectModelInterfaceProvider } from "./connect-model.js";
import type {
  UiConnectModelInput,
  UiConnectModelInterfaceProvider,
  UiCurrentModelInterfaceProvider,
  UiProbeModelContextWindowInput,
} from "./connect-model.js";

describe("model interface-provider UI boundary", () => {
  it("accepts the same three protocols for current, connect and probe", () => {
    expectTypeOf<UiConnectModelInterfaceProvider>().toEqualTypeOf<
      "openai-compatible" | "openai-responses" | "anthropic"
    >();
    expectTypeOf<UiCurrentModelInterfaceProvider>().toEqualTypeOf<UiConnectModelInterfaceProvider>();
    expectTypeOf<
      UiConnectModelInput["interfaceProvider"]
    >().toEqualTypeOf<UiConnectModelInterfaceProvider>();
    expectTypeOf<
      UiProbeModelContextWindowInput["interfaceProvider"]
    >().toEqualTypeOf<UiConnectModelInterfaceProvider>();
    const choice: UiConnectModelInterfaceProvider = "openai-responses";
    expect(choice).toBe("openai-responses");
  });
  it("keeps legacy URL inference and defaults OpenAI to Chat", () => {
    expect(
      inferConnectModelInterfaceProvider("https://api.openai.com/v1"),
    ).toBe("openai-compatible");
    expect(
      inferConnectModelInterfaceProvider("https://api.anthropic.com"),
    ).toBe("anthropic");
  });
});
