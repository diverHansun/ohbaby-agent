import { describe, expect, it } from "vitest";
import type { UiCurrentModelConfig } from "ohbaby-sdk";
import { footerEffort, formatFooterRows } from "./footer.js";
import { visibleWidth } from "../../render/wrap.js";

const model: UiCurrentModelConfig = {
  provider: "test",
  baseUrl: "https://example.test",
  interfaceProvider: "anthropic",
  model: "claude-opus-5.5",
  reasoning: {
    status: "identified",
    mode: "effort",
    efforts: ["low", "high"],
    default: { effort: "low" },
  },
};

describe("footer current configuration", () => {
  it("uses compatible effort or confirmed default and never guesses capability", () => {
    expect(footerEffort(model, { effort: "high" })).toBe("high");
    expect(footerEffort(model, { effort: "obsolete" })).toBe("low");
    expect(footerEffort(model, null)).toBe("low");
    expect(
      footerEffort({ ...model, reasoning: undefined }, { effort: "high" }),
    ).toBe("unknown");
    expect(
      footerEffort(
        {
          ...model,
          reasoning: { status: "identified", mode: "none", efforts: [] },
        },
        { effort: "high" },
      ),
    ).toBe("n/a");
    expect(
      footerEffort(
        {
          ...model,
          reasoning: {
            status: "identified",
            mode: "binary",
            efforts: [],
            supportsDisabled: true,
          },
        },
        { enabled: false },
      ),
    ).toBe("off");
    expect(
      footerEffort(
        {
          ...model,
          reasoning: { status: "identified", mode: "binary", efforts: [] },
        },
        { enabled: true },
      ),
    ).toBe("on");
    expect(
      footerEffort(
        {
          ...model,
          reasoning: { status: "identified", mode: "effort", efforts: ["low"] },
        },
        { effort: "high" },
      ),
    ).toBe("unknown");
  });
  it("does not claim incompatible explicit effort is binary on", () => {
    const binary = {
      ...model,
      reasoning: {
        status: "identified" as const,
        mode: "binary" as const,
        efforts: [],
      },
    };
    expect(footerEffort(binary, { enabled: true, effort: "high" })).toBe(
      "unknown",
    );
    expect(
      footerEffort(
        {
          ...binary,
          reasoning: { ...binary.reasoning, default: { enabled: true } },
        },
        { enabled: true, effort: "high" },
      ),
    ).toBe("on");
  });
  it.each([120, 80, 60, 12])("bounds both rows at %i columns", (width) => {
    const rows = formatFooterRows({
      width,
      projectRoot: "/users/test/项目/中文路径/🙂/very-long-project-name",
      model,
      reasoning: { effort: "high" },
      permission: { mode: "auto", level: "default", sessionRules: [] },
      usage: "0.2% 2k/1m",
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    if (width >= 60) {
      expect(rows[0]).toMatch(/auto\/default$/);
      expect(rows[1]).toMatch(/high\s+0.2% 2k\/1m$/);
    }
    expect(rows.join("\n")).not.toMatch(/Permission|Context|effort/);
  });
  it("clears missing current session fields instead of inventing values", () => {
    const rows = formatFooterRows({ width: 80 });
    expect(rows[0]).toMatch(/^unknown\s+unknown$/);
    expect(rows[1]).toMatch(/^unknown · unknown\s+—$/);
  });
});
