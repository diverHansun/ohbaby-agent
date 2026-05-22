import { describe, expect, it } from "vitest";
import { SkillNotFoundError } from "./errors.js";
import { SkillRegistry } from "./registry.js";
import type { SkillContent, SkillInfo } from "./types.js";

const baseSkill = {
  allowedTools: [],
  baseDir: "/skills/base",
  description: "Base",
  disableModelInvocation: false,
  frontmatter: { description: "Base", name: "base" },
  location: "/skills/base/SKILL.md",
  metadata: {},
  name: "base",
  scope: "project",
  source: "project-native",
  userInvocable: true,
} satisfies SkillInfo;

function makeContent(info: SkillInfo): SkillContent {
  return {
    baseDir: info.baseDir,
    content: `# ${info.name}`,
    files: [],
    info,
  };
}

describe("SkillRegistry", () => {
  it("caches scan results until invalidated and filters trigger paths independently", async () => {
    let scanCount = 0;
    const agentOnly = {
      ...baseSkill,
      baseDir: "/skills/agent-only",
      description: "Agent only",
      name: "agent-only",
      userInvocable: false,
    } satisfies SkillInfo;
    const userOnly = {
      ...baseSkill,
      baseDir: "/skills/user-only",
      description: "User only",
      disableModelInvocation: true,
      name: "user-only",
    } satisfies SkillInfo;
    const registry = new SkillRegistry({
      loader: {
        loadContent: (info: SkillInfo): Promise<SkillContent> =>
          Promise.resolve(makeContent(info)),
        scan: (): Promise<Map<string, SkillInfo>> => {
          scanCount += 1;
          return Promise.resolve(
            new Map<string, SkillInfo>([
              [baseSkill.name, baseSkill],
              [agentOnly.name, agentOnly],
              [userOnly.name, userOnly],
            ]),
          );
        },
      },
    });

    await expect(registry.all()).resolves.toHaveLength(3);
    await expect(registry.all()).resolves.toHaveLength(3);
    expect(scanCount).toBe(1);
    await expect(
      registry.listUserInvocable().then((skills) => skills.map((s) => s.name)),
    ).resolves.toEqual(["base", "user-only"]);
    await expect(
      registry.listModelInvocable().then((skills) => skills.map((s) => s.name)),
    ).resolves.toEqual(["agent-only", "base"]);

    registry.invalidate();
    await registry.all();
    expect(scanCount).toBe(2);
  });

  it("throws a helpful not-found error with available skill names", async () => {
    const registry = new SkillRegistry({
      loader: {
        loadContent: (info: SkillInfo): Promise<SkillContent> =>
          Promise.resolve(makeContent(info)),
        scan: (): Promise<Map<string, SkillInfo>> =>
          Promise.resolve(
            new Map<string, SkillInfo>([[baseSkill.name, baseSkill]]),
          ),
      },
    });

    await expect(registry.load("missing")).rejects.toMatchObject({
      availableSkills: ["base"],
      name: "SkillNotFoundError",
      skillName: "missing",
    } satisfies Partial<SkillNotFoundError>);
  });

  it("invalidates cached skills when plugin directories are registered or removed", async () => {
    const pluginSkill = {
      ...baseSkill,
      baseDir: "/plugins/example/skills/plugin-skill",
      description: "Plugin skill",
      location: "/plugins/example/skills/plugin-skill/SKILL.md",
      name: "plugin-skill",
      pluginId: "example-plugin",
      source: "plugin",
    } satisfies SkillInfo;
    let includePlugin = false;
    let scanCount = 0;
    let changeCount = 0;
    const registry = new SkillRegistry({
      loader: {
        deregisterPlugin(pluginId): void {
          expect(pluginId).toBe("example-plugin");
          includePlugin = false;
        },
        loadContent: (info: SkillInfo): Promise<SkillContent> =>
          Promise.resolve(makeContent(info)),
        registerPluginSkills(pluginId, directories): void {
          expect(pluginId).toBe("example-plugin");
          expect(directories).toEqual(["/plugins/example/skills"]);
          includePlugin = true;
        },
        scan: (): Promise<Map<string, SkillInfo>> => {
          scanCount += 1;
          const entries: [string, SkillInfo][] = [[baseSkill.name, baseSkill]];
          if (includePlugin) {
            entries.push([pluginSkill.name, pluginSkill]);
          }
          return Promise.resolve(new Map<string, SkillInfo>(entries));
        },
      },
    });
    registry.onChange(() => {
      changeCount += 1;
    });

    await expect(registry.listNames()).resolves.toEqual(["base"]);
    registry.registerPluginSkills("example-plugin", [
      "/plugins/example/skills",
    ]);
    await expect(registry.listNames()).resolves.toEqual([
      "base",
      "plugin-skill",
    ]);
    registry.deregisterPlugin("example-plugin");
    await expect(registry.listNames()).resolves.toEqual(["base"]);
    expect(scanCount).toBe(3);
    expect(changeCount).toBe(2);
  });
});
