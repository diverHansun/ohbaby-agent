import { describe, expect, it } from "vitest";
import { modelConnectInputFromBody } from "./request-helpers.js";
import { createOpenApiDocument } from "../../app/openapi.js";

const connection = {
  provider: "fixture",
  model: "fixture",
  baseUrl: "https://fixture.test",
  interfaceProvider: "openai-compatible",
};

describe("model token override contract", () => {
  it("preserves explicit null clears and omitted values at the HTTP boundary", () => {
    expect(
      modelConnectInputFromBody({
        ...connection,
        contextWindowTokens: null,
        maxOutputTokens: null,
      }),
    ).toEqual({
      ...connection,
      contextWindowTokens: null,
      maxOutputTokens: null,
    });
    expect(modelConnectInputFromBody(connection)).toEqual(connection);
  });
  it.each([0, -1, 1.5, "", "100"])(
    "rejects malformed numeric override %j",
    (value) => {
      expect(
        modelConnectInputFromBody({
          ...connection,
          contextWindowTokens: value,
        }),
      ).toBeUndefined();
      expect(
        modelConnectInputFromBody({ ...connection, maxOutputTokens: value }),
      ).toBeUndefined();
    },
  );
  it("documents nullable patch/connect overrides and distinct effective read fields", () => {
    const document = createOpenApiDocument("test") as {
      components: {
        schemas: Record<
          string,
          { required?: string[]; properties: Record<string, unknown> }
        >;
      };
    };
    const schemas = document.components.schemas;
    expect(schemas.SettingsModelCreate.properties.contextWindowTokens).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(
      schemas.SettingsModelPatch.properties.contextWindowTokens,
    ).toMatchObject({ type: ["integer", "null"], minimum: 1 });
    expect(schemas.SettingsModelPatch.properties.maxOutputTokens).toMatchObject(
      { type: ["integer", "null"], minimum: 1 },
    );
    expect(
      schemas.ConnectModelInput.properties.contextWindowTokens,
    ).toMatchObject({ type: ["integer", "null"] });
    expect(schemas.SettingsModel.required).toEqual(
      expect.arrayContaining([
        "effectiveContextWindowTokens",
        "effectiveMaxOutputTokens",
        "contextDiscovery",
      ]),
    );
    expect(schemas.SettingsModel.required).not.toContain("contextWindowTokens");
    expect(schemas.ReasoningCapabilityView.properties).not.toHaveProperty(
      "stale",
    );
  });
});
