import { describe, expect, it } from "vitest";
import { AgentConfigSchema, AgentsConfigSchema } from "../types.js";

const VALID_PRIMARY_AGENT = {
  name: "build",
  mode: "primary",
  description: "Full-featured development agent",
  color: "#00A67E",
  maxSteps: 50,
  timeout: 300_000,
  model: "anthropic/claude-sonnet-4.5",
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  tools: {
    include: ["read", "bash"],
    exclude: ["task"],
  },
  permission: {
    edit: "ask",
    bash: {
      "git *": "allow",
      "*": "ask",
    },
    web: "allow",
    mcp: "ask",
    externalDirectory: "ask",
    doomLoop: "deny",
    critical: {
      bashPatterns: ["git push *"],
    },
  },
} as const;

describe("AgentConfigSchema", () => {
  it("accepts a complete primary agent config and applies boolean defaults", () => {
    const parsed = AgentConfigSchema.parse(VALID_PRIMARY_AGENT);

    expect(parsed).toMatchObject({
      name: "build",
      mode: "primary",
      hidden: false,
      default: false,
      disabled: false,
      allowDoomLoop: false,
      model: "anthropic/claude-sonnet-4.5",
    });
  });

  it("accepts explicit agent prompts in configuration", () => {
    const parsed = AgentConfigSchema.parse({
      ...VALID_PRIMARY_AGENT,
      prompt: "Use this agent-specific system prompt.",
    });

    expect(parsed.prompt).toBe("Use this agent-specific system prompt.");
  });

  it("rejects blank explicit agent prompts", () => {
    expect(() =>
      AgentConfigSchema.parse({
        ...VALID_PRIMARY_AGENT,
        prompt: "   ",
      }),
    ).toThrow(/prompt/i);
  });

  it("accepts an active subagent only when description is present", () => {
    expect(() =>
      AgentConfigSchema.parse({
        name: "explore",
        mode: "subagent",
      }),
    ).toThrow(/description/i);

    expect(() =>
      AgentConfigSchema.parse({
        name: "explore",
        mode: "subagent",
        description: "Find and summarize relevant code.",
      }),
    ).not.toThrow();
  });

  it("allows a disabled subagent stub without description for full replacement", () => {
    const parsed = AgentConfigSchema.parse({
      name: "research",
      mode: "subagent",
      disabled: true,
    });

    expect(parsed.disabled).toBe(true);
  });

  it("rejects invalid scalar fields with useful paths", () => {
    const result = AgentConfigSchema.safeParse({
      ...VALID_PRIMARY_AGENT,
      mode: "invalid",
      color: "green",
      temperature: 3,
      topP: 2,
      maxSteps: 0,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(
        expect.arrayContaining([
          "mode",
          "color",
          "temperature",
          "topP",
          "maxSteps",
        ]),
      );
    }
  });

  it("rejects model ids without a provider/model separator but allows dotted model names", () => {
    expect(() =>
      AgentConfigSchema.parse({
        ...VALID_PRIMARY_AGENT,
        model: "anthropic/claude-sonnet-4.5",
      }),
    ).not.toThrow();

    expect(() =>
      AgentConfigSchema.parse({
        ...VALID_PRIMARY_AGENT,
        model: "claude-sonnet-4.5",
      }),
    ).toThrow(/model/i);
  });
});

describe("AgentsConfigSchema", () => {
  it("accepts an empty agents object", () => {
    expect(AgentsConfigSchema.parse({ agents: {} })).toEqual({ agents: {} });
  });

  it("validates every configured agent", () => {
    expect(() =>
      AgentsConfigSchema.parse({
        agents: {
          build: VALID_PRIMARY_AGENT,
          broken: {
            name: "broken",
            mode: "subagent",
          },
        },
      }),
    ).toThrow(/description/i);
  });
});
