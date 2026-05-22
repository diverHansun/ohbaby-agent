import { describe, expect, it } from "vitest";
import {
  buildSkillToolDescription,
  createSkillTool,
  formatSkillToolOutput,
} from "./tool.js";
import type { SkillContent, SkillInfo } from "./types.js";

function skill(input: {
  readonly name: string;
  readonly description: string;
  readonly disableModelInvocation?: boolean;
}): SkillInfo {
  return {
    baseDir: `/skills/${input.name}`,
    description: input.description,
    disableModelInvocation: input.disableModelInvocation ?? false,
    location: `/skills/${input.name}/SKILL.md`,
    name: input.name,
    scope: "project",
    userInvocable: true,
  };
}

function content(info: SkillInfo): SkillContent {
  return {
    baseDir: info.baseDir,
    content: "# Instructions\n\nDo the thing.",
    files: ["script.ts"],
    info,
  };
}

describe("SkillTool", () => {
  it("builds an available-skills description from model-invocable skills only", async () => {
    const description = await buildSkillToolDescription(
      {
        listModelInvocable: () =>
          Promise.resolve([
            skill({ name: "commit", description: "Commit guidance" }),
            skill({
              name: "internal",
              description: "Hidden",
              disableModelInvocation: true,
            }),
          ]),
      },
      { contextWindowTokens: 10_000 },
    );

    expect(description).toContain("<available_skills>");
    expect(description).toContain("- commit: Commit guidance");
    expect(description).not.toContain("internal");
  });

  it("keeps the skill tool registered with a clear empty-state description", async () => {
    await expect(
      buildSkillToolDescription(
        { listModelInvocable: () => Promise.resolve([]) },
        { contextWindowTokens: 10_000 },
      ),
    ).resolves.toContain("No skills are currently available.");
  });

  it("falls back to names only when descriptions exceed the context budget", async () => {
    const skills = Array.from({ length: 30 }, (_, index) =>
      skill({
        name: `skill-${String(index)}`,
        description: "x".repeat(250),
      }),
    );

    const description = await buildSkillToolDescription(
      { listModelInvocable: () => Promise.resolve(skills) },
      { contextWindowTokens: 100 },
    );

    expect(description).toContain("- skill-0");
    expect(description).not.toContain("xxx");
  });

  it("executes by loading and formatting skill content", async () => {
    const codeReview = skill({
      name: "code-review",
      description: "Review code",
    });
    const tool = await createSkillTool({
      listModelInvocable: () => Promise.resolve([codeReview]),
      load: (name: string) => {
        expect(name).toBe("code-review");
        return Promise.resolve(content(codeReview));
      },
    });

    const result = await tool.execute(
      { name: "code-review" },
      {
        callId: "call_1",
        messageId: "message_1",
        sessionId: "session_1",
        signal: new AbortController().signal,
      },
    );

    expect(tool).toMatchObject({
      category: "skill",
      name: "skill",
      source: "module",
    });
    expect(result.output).toContain("## Skill: code-review");
    expect(result.output).toContain("**Available files**");
    expect(result.metadata).toEqual({
      dir: "/skills/code-review",
      files: ["script.ts"],
      name: "code-review",
    });
  });

  it("formats content without an empty helper section", () => {
    const info = skill({ name: "plain", description: "Plain" });
    expect(
      formatSkillToolOutput({ ...content(info), files: [] }),
    ).not.toContain("**Available files**");
  });
});
