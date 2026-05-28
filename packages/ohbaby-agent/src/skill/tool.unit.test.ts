import { describe, expect, it, vi } from "vitest";
import type {
  ToolCommandContext,
  ToolExecutionEnvironment,
} from "../core/tool-scheduler/index.js";
import type { TrustedRoot } from "../sandbox/index.js";
import {
  buildSkillToolDescription,
  createSkillResourceTool,
  createSkillTool,
  formatSkillToolOutput,
} from "./tool.js";
import type { SkillContent, SkillInfo, SkillResourceContent } from "./types.js";

function activationEnvironment(
  trustPath: NonNullable<ToolExecutionEnvironment["trustPath"]>,
): ToolExecutionEnvironment {
  return {
    containsTrustedPath: (): boolean => false,
    resolveCommandContext: (): ToolCommandContext => ({
      cwd: "/workspace",
      kind: "host-local",
    }),
    resolvePath: (inputPath: string) => inputPath,
    resolvePathForExisting: (inputPath: string): Promise<string> =>
      Promise.resolve(inputPath),
    resolvePathForWrite: (inputPath: string): Promise<string> =>
      Promise.resolve(inputPath),
    trustPath,
    trustedRoots: (): readonly TrustedRoot[] => [],
    workdir: "/workspace",
  };
}

function skill(input: {
  readonly name: string;
  readonly description: string;
  readonly disableModelInvocation?: boolean;
}): SkillInfo {
  return {
    allowedTools: [],
    baseDir: `/skills/${input.name}`,
    description: input.description,
    disableModelInvocation: input.disableModelInvocation ?? false,
    frontmatter: {
      description: input.description,
      name: input.name,
    },
    location: `/skills/${input.name}/SKILL.md`,
    metadata: {},
    name: input.name,
    scope: "project",
    source: "project-native",
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

function resource(info: SkillInfo): SkillResourceContent {
  return {
    baseDir: info.baseDir,
    content: "Reference notes\n",
    info,
    path: "references/notes.md",
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
      get: (name: string) => {
        expect(name).toBe("code-review");
        return Promise.resolve(codeReview);
      },
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

  it("activates the exact skill base directory after loading", async () => {
    const codeReview = skill({
      name: "code-review",
      description: "Review code",
    });
    const trustPath = vi.fn();
    const tool = await createSkillTool({
      get: () => Promise.resolve(codeReview),
      listModelInvocable: () => Promise.resolve([codeReview]),
      load: () => Promise.resolve(content(codeReview)),
    });

    await tool.execute(
      { name: "code-review" },
      {
        callId: "call_1",
        environment: activationEnvironment(trustPath),
        messageId: "message_1",
        sessionId: "session_1",
        signal: new AbortController().signal,
      },
    );

    expect(trustPath).toHaveBeenCalledWith({
      kind: "active-skill",
      path: "/skills/code-review",
      source: "code-review",
    });
  });

  it("blocks direct model loads for model-disabled skills", async () => {
    const hidden = skill({
      description: "Hidden",
      disableModelInvocation: true,
      name: "hidden",
    });
    const tool = await createSkillTool({
      get: () => Promise.resolve(hidden),
      listModelInvocable: () => Promise.resolve([]),
      load: () => {
        throw new Error("disabled skill should not load");
      },
    });

    await expect(
      tool.execute(
        { name: "hidden" },
        {
          callId: "call_1",
          messageId: "message_1",
          sessionId: "session_1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/disabled for model invocation/u);
  });

  it("formats content without an empty helper section", () => {
    const info = skill({ name: "plain", description: "Plain" });
    expect(
      formatSkillToolOutput({ ...content(info), files: [] }),
    ).not.toContain("**Available files**");
  });

  it("reads skill resources through a dedicated read-only tool", async () => {
    const info = skill({ name: "docs", description: "Docs" });
    const tool = createSkillResourceTool({
      get: (name: string) => {
        expect(name).toBe("docs");
        return Promise.resolve(info);
      },
      readResource: (name: string, resourcePath: string) => {
        expect(name).toBe("docs");
        expect(resourcePath).toBe("references/notes.md");
        return Promise.resolve(resource(info));
      },
    });

    const result = await tool.execute(
      { name: "docs", path: "references/notes.md" },
      {
        callId: "call_1",
        messageId: "message_1",
        sessionId: "session_1",
        signal: new AbortController().signal,
      },
    );

    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true },
      category: "skill",
      name: "skill_resource",
      source: "module",
    });
    expect(result.output).toContain("Reference notes");
    expect(result.metadata).toEqual({
      dir: "/skills/docs",
      name: "docs",
      path: "references/notes.md",
    });
  });

  it("activates the exact skill base directory after reading a resource", async () => {
    const info = skill({ name: "docs", description: "Docs" });
    const trustPath = vi.fn();
    const tool = createSkillResourceTool({
      get: () => Promise.resolve(info),
      readResource: () => Promise.resolve(resource(info)),
    });

    await tool.execute(
      { name: "docs", path: "references/notes.md" },
      {
        callId: "call_1",
        environment: activationEnvironment(trustPath),
        messageId: "message_1",
        sessionId: "session_1",
        signal: new AbortController().signal,
      },
    );

    expect(trustPath).toHaveBeenCalledWith({
      kind: "active-skill",
      path: "/skills/docs",
      source: "docs",
    });
  });

  it("blocks model resource reads for model-disabled skills", async () => {
    const info = skill({
      description: "Hidden docs",
      disableModelInvocation: true,
      name: "hidden-docs",
    });
    const tool = createSkillResourceTool({
      get: () => Promise.resolve(info),
      readResource: () => {
        throw new Error("disabled skill resource should not load");
      },
    });

    await expect(
      tool.execute(
        { name: "hidden-docs", path: "references/notes.md" },
        {
          callId: "call_1",
          messageId: "message_1",
          sessionId: "session_1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/disabled for model invocation/u);
  });
});
