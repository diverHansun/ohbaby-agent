import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  UiConnectModelInput,
  UiConnectModelInterfaceProvider,
  UiCurrentModelInterfaceProvider,
  UiProbeModelContextWindowInput,
} from "./connect-model.js";

describe("model interface-provider UI boundary", () => {
  it("keeps Responses display-only while connect and probe retain their two protocol choices", () => {
    expectTypeOf<UiCurrentModelInterfaceProvider>().toEqualTypeOf<
      "openai-compatible" | "anthropic" | "openai-responses"
    >();
    expectTypeOf<UiConnectModelInterfaceProvider>().toEqualTypeOf<
      "openai-compatible" | "anthropic"
    >();
    expectTypeOf<
      UiConnectModelInput["interfaceProvider"]
    >().toEqualTypeOf<UiConnectModelInterfaceProvider>();
    expectTypeOf<
      UiProbeModelContextWindowInput["interfaceProvider"]
    >().toEqualTypeOf<UiConnectModelInterfaceProvider>();

    const currentKind: UiCurrentModelInterfaceProvider = "openai-responses";
    const connectKind: UiConnectModelInterfaceProvider = "openai-compatible";
    // @ts-expect-error Responses is not a connect/probe selection.
    const rejectedConnectKind: UiConnectModelInterfaceProvider =
      "openai-responses";

    expect({ connectKind, currentKind }).toEqual({
      connectKind: "openai-compatible",
      currentKind: "openai-responses",
    });
    expect(rejectedConnectKind).toBe("openai-responses");
  });
});
