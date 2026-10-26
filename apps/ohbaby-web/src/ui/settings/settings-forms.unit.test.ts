import type { UiSettingsModel, UiSettingsSearch } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import {
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

  it.each(["[REDACTED]", "%5BREDACTED%5D"])(
    "requires a full replacement when editing a model URL containing %s",
    (mask) => {
      const base = modelFormFrom({
        ...saved,
        baseUrl: `https://acme.test/v1?token=${mask}`,
      });
      const changed = {
        ...base,
        baseUrl: `https://acme.test/v2?token=${mask}`,
      };
      expect(validateModelForm(changed, base).baseUrl).toEqual(
        expect.stringContaining("Replace the entire URL"),
      );
      expect(modelFormSavable(changed, base, false)).toBe(false);
      expect(validateModelForm(changed, null).baseUrl).toBeDefined();

      const relabeled = { ...base, label: "Personal" };
      expect(validateModelForm(relabeled, base)).toEqual({});
      expect(modelFormSavable(relabeled, base, false)).toBe(true);
      expect(modelPatchRequest(relabeled, base)).toEqual({ label: "Personal" });

      const replaced = { ...base, baseUrl: "https://new.test/v1" };
      expect(validateModelForm(replaced, base)).toEqual({});
      expect(modelFormSavable(replaced, base, false)).toBe(true);
      expect(validateModelForm({ ...base, baseUrl: "" }, base).baseUrl).toBe(
        "Required",
      );
    },
  );

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

  it("confirms a legacy entry without a credential reference as keyless", () => {
    const base = modelFormFrom({
      ...saved,
      apiKeyEnv: undefined,
      apiKeyConfigured: false,
      configurationComplete: false,
    });
    expect(modelFormSavable(base, base, true)).toBe(true);
    expect(modelPatchRequest(base, base, true)).toEqual({ apiKeyEnv: null });
    // Completed keyless entries still send only the user's changed fields.
    expect(modelPatchRequest(base, base, false)).toEqual({});
    expect(modelFormSavable(base, base, false)).toBe(false);
  });

  it("preserves an existing or newly supplied credential when completing setup", () => {
    const referenced = modelFormFrom(saved);
    expect(modelPatchRequest(referenced, referenced, true)).toEqual({});
    const keyless = { ...referenced, apiKeyEnv: "" };
    expect(
      modelPatchRequest({ ...keyless, apiKeyEnv: "NEW_KEY" }, keyless, true),
    ).toEqual({ apiKeyEnv: "NEW_KEY" });
    expect(
      modelPatchRequest(
        { ...keyless, secret: { replace: "new-key" } },
        keyless,
        true,
      ),
    ).toEqual({ apiKey: "new-key" });
    expect(
      modelPatchRequest({ ...keyless, secret: "clear" }, keyless, true),
    ).toEqual({ apiKey: "" });
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

  it.each(["[REDACTED]", "%5BREDACTED%5D"])(
    "requires a full replacement when editing a search URL containing %s",
    (mask) => {
      const base = searchFormFrom({
        ...settings,
        baseUrl: `https://search.test/v1?token=${mask}`,
      });
      const changed = {
        ...base,
        baseUrl: `https://search.test/v2?token=${mask}`,
      };
      expect(validateSearchForm(changed, base).baseUrl).toEqual(
        expect.stringContaining("Replace the entire URL"),
      );

      const timed = { ...base, timeout: "120" };
      expect(validateSearchForm(timed, base)).toEqual({});
      expect(searchUpdateRequest(timed, base)).toEqual({
        defaults: { timeout: 120 },
      });

      const replaced = { ...base, baseUrl: "https://new.test/search" };
      expect(validateSearchForm(replaced, base)).toEqual({});
      expect(searchUpdateRequest(replaced, base)).toEqual({
        baseUrl: "https://new.test/search",
      });
      const cleared = { ...base, baseUrl: "" };
      expect(validateSearchForm(cleared, base)).toEqual({});
      expect(searchUpdateRequest(cleared, base)).toEqual({ baseUrl: null });
    },
  );

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
