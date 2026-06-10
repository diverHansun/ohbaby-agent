import { describe, expect, it } from "vitest";
import {
  createTemporarySessionTitle,
  sanitizePromptForSessionTitle,
} from "./prompt-sanitizer.js";

describe("session prompt sanitizer", () => {
  it("redacts common secrets before sending prompt text to the title model", () => {
    const sanitized = sanitizePromptForSessionTitle(
      [
        "请帮我检查登录失败",
        "OPENAI_API_KEY=sk-ai-v1-secret-token",
        "Authorization: Bearer ghp_super_secret_token",
        "password: hunter2",
      ].join("\n"),
    );

    expect(sanitized).toContain("OPENAI_API_KEY=[redacted]");
    expect(sanitized).toContain("Authorization: Bearer [redacted]");
    expect(sanitized).toContain("password: [redacted]");
    expect(sanitized).not.toContain("sk-ai-v1-secret-token");
    expect(sanitized).not.toContain("ghp_super_secret_token");
    expect(sanitized).not.toContain("hunter2");
  });

  it("collapses whitespace and truncates first-message prompt text", () => {
    const sanitized = sanitizePromptForSessionTitle(
      `  first line\n\nsecond line ${"x".repeat(200)}`,
      { maxLength: 40 },
    );

    expect(sanitized).toBe("first line second line xxxxxxxxxxxxxx...");
  });

  it("creates a short temporary title from the first user message", () => {
    const title = createTemporarySessionTitle(
      `  请分析这个报错并修复 ${"很长".repeat(40)} TOKEN=secret-value  `,
    );

    expect(title).toContain("请分析这个报错并修复");
    expect(title).toContain("...");
    expect(title).not.toContain("secret-value");
    expect(title.length).toBeLessThanOrEqual(48);
  });
});
