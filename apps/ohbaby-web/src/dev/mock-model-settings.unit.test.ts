import { expect, it } from "vitest";
import { createMockSettingsApi } from "./mock-settings.js";

const immediately = (): Promise<void> => Promise.resolve();

it("keeps an independent subagent choice and clears it when the model is deleted", async () => {
  const api = createMockSettingsApi("settings", immediately);
  await expect(
    api.selectSubagentModel({
      id: "m2",
      reasoning: { enabled: true, effort: "unsupported" },
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const reasoning = { enabled: true, effort: "low" };
  const selected = await api.selectSubagentModel({ id: "m2", reasoning });
  expect(selected.active?.id).toBe("m1");
  expect(selected.subagent).toMatchObject({ id: "m2", reasoning });
  expect((await api.deleteModel("m2")).subagent).toBeNull();
});

it("keeps a cleanup notice across probes and label saves, then clears it on a manual reasoning choice", async () => {
  const api = createMockSettingsApi("settings", immediately);
  await api.probeModel("m6");
  const labelled = await api.updateModel("m6", { label: "Research" });
  expect(
    labelled.models.find((model) => model.id === "m6")?.reasoningNotice,
  ).toBe("unsupported-anthropic-effort-cleared");
  const selected = await api.updateModel("m6", {
    reasoning: { enabled: true, effort: "high" },
  });
  expect(
    selected.models.find((model) => model.id === "m6")?.reasoningNotice,
  ).toBeUndefined();
  expect(
    selected.models.find((model) => model.id === "m6")?.reasoningDefault,
  ).toEqual({ enabled: true, effort: "high" });
});

it("includes the safety reserve when marking an incompatible token budget", async () => {
  const api = createMockSettingsApi("settings", immediately);
  const invalid = await api.updateModel("m3", {
    contextWindowTokens: 33792,
    maxOutputTokens: 32768,
  });
  expect(
    invalid.models.find((model) => model.id === "m3")?.tokenBudgetIssue,
  ).toEqual({
    code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE",
    contextWindowTokens: 33792,
    maxOutputTokens: 32768,
  });
  const valid = await api.updateModel("m3", { contextWindowTokens: 33793 });
  expect(
    valid.models.find((model) => model.id === "m3")?.tokenBudgetIssue,
  ).toBeUndefined();
});
