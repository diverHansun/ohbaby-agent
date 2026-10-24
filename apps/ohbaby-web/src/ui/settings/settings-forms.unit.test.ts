import type { UiSettingsModel, UiSettingsSearch } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import {
  createdModelId,
  EMPTY_MODEL_FORM,
  fieldErrorsFrom,
  groupModels,
  modelCreateRequest,
  modelFormFrom,
  modelFormSavable,
  modelPatchRequest,
  validateModelForm,
} from "./model-form.js";
import {
  searchErrorsFrom,
  searchFormFrom,
  searchUpdateRequest,
  validateSearchForm,
} from "./search-form.js";
import { secretPatch } from "./secret.js";

const saved: UiSettingsModel = {
  id: "m1",
  provider: "acme",
  model: "acme-1",
  label: "Work",
  baseUrl: "https://acme.test/v1",
  interfaceProvider: "openai-compatible",
  apiKeyEnv: "ACME_KEY",
  apiKeyConfigured: true,
  configurationComplete: true,
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_000,
  promptCache: "auto",
  reasoning: { status: "unknown", efforts: [] },
};

describe("model form", () => {
  it("maps the key's three states", () => {
    expect(secretPatch("keep")).toBeUndefined();
    expect(secretPatch("clear")).toBe("");
    expect(secretPatch({ replace: "new" })).toBe("new");
  });

  it("sends only changed fields, null for an emptied label and '' for Clear", () => {
    const base = modelFormFrom(saved);
    expect(modelPatchRequest(base, base)).toEqual({});
    expect(
      modelPatchRequest({ ...base, label: " ", secret: "clear" }, base),
    ).toEqual({ label: null, apiKey: "" });
    expect(
      modelPatchRequest(
        { ...base, model: "acme-2", contextWindowTokens: "64000" },
        base,
      ),
    ).toEqual({ model: "acme-2", contextWindowTokens: 64000 });
    // An unchanged replacement field is no change.
    expect(
      modelPatchRequest({ ...base, secret: { replace: "" } }, base),
    ).toEqual({});
  });

  it("leaves empty optional fields out of a new entry", () => {
    expect(
      modelCreateRequest({
        ...EMPTY_MODEL_FORM,
        provider: " acme ",
        model: "acme-1",
        baseUrl: "https://acme.test/v1",
      }),
    ).toEqual({
      provider: "acme",
      model: "acme-1",
      baseUrl: "https://acme.test/v1",
      interfaceProvider: "openai-compatible",
    });
  });

  it("blocks clearing a saved value that has no clear protocol", () => {
    const base = modelFormFrom(saved);
    for (const field of [
      "apiKeyEnv",
      "contextWindowTokens",
      "maxOutputTokens",
    ] as const) {
      const form = { ...base, [field]: "" };
      expect(validateModelForm(form, base)[field]).toContain(
        "can't be cleared",
      );
      expect(modelFormSavable(form, base, false)).toBe(false);
    }
    expect(
      validateModelForm({ ...base, promptCache: "" }, base).promptCache,
    ).toBeDefined();
  });

  it("lets a completed Needs setup entry save without other changes", () => {
    const legacy = modelFormFrom({
      ...saved,
      configurationComplete: false,
      baseUrl: undefined,
      interfaceProvider: undefined,
    });
    expect(modelFormSavable(legacy, legacy, true)).toBe(false);
    const filled = {
      ...legacy,
      baseUrl: "https://acme.test/v1",
      interfaceProvider: "anthropic" as const,
    };
    expect(modelFormSavable(filled, legacy, true)).toBe(true);
    expect(modelPatchRequest(filled, legacy)).toEqual({
      baseUrl: "https://acme.test/v1",
      interfaceProvider: "anthropic",
    });
  });

  it("puts server field errors under inputs and the rest beside Save", () => {
    expect(
      fieldErrorsFrom(
        [
          { path: ["baseUrl"], message: "Must be an http or https URL" },
          { path: ["nested", 0], message: "Is not valid" },
        ],
        "fallback",
      ),
    ).toEqual({
      baseUrl: "Must be an http or https URL",
      form: "nested.0: Is not valid",
    });
    expect(fieldErrorsFrom(undefined, "fallback")).toEqual({
      form: "fallback",
    });
  });

  it("picks the new entry from this POST's own response for D20", () => {
    const other = { ...saved, id: "from-another-window" };
    const created = { ...saved, id: "mine" };
    expect(
      createdModelId({
        active: null,
        params: { maxTokens: 1 },
        models: [saved, other, created],
      }),
    ).toBe("mine");
  });

  it("groups by first appearance and keeps the server order", () => {
    const rows = [
      { ...saved, id: "1", provider: "b" },
      { ...saved, id: "2", provider: "a" },
      { ...saved, id: "3", provider: "b" },
    ];
    expect(
      groupModels(rows).map((group) => [
        group.provider,
        group.models.map((model) => model.id),
      ]),
    ).toEqual([
      ["b", ["1", "3"]],
      ["a", ["2"]],
    ]);
  });
});

describe("search form", () => {
  const settings: UiSettingsSearch = {
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    apiKeyConfigured: true,
    baseUrl: "https://search.test",
    defaults: {
      searchDepth: "basic",
      maxResults: 5,
      topic: "general",
      timeout: 60,
    },
  };

  it("sends only changed fields and null for an emptied Base URL", () => {
    const base = searchFormFrom(settings);
    expect(searchUpdateRequest(base, base)).toEqual({});
    expect(
      searchUpdateRequest(
        { ...base, baseUrl: "", timeout: "120", secret: { replace: "k" } },
        base,
      ),
    ).toEqual({ apiKey: "k", baseUrl: null, defaults: { timeout: 120 } });
  });

  it("checks the server's ranges", () => {
    const base = searchFormFrom(settings);
    expect(
      validateSearchForm({ ...base, maxResults: "21", timeout: "0" }, base),
    ).toEqual({
      maxResults: "Must be a whole number from 1 to 20",
      timeout: "Must be a whole number from 1 to 600",
    });
  });

  it("maps nested default paths to their fields", () => {
    expect(
      searchErrorsFrom(
        [{ path: ["defaults", "timeout"], message: "Must be at most 600" }],
        "fallback",
      ),
    ).toEqual({ timeout: "Must be at most 600" });
  });
});
