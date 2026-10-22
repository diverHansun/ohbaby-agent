import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLoader } from "./loader.js";
import { describe, expect, it, vi } from "vitest";
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

describe("Skill file refresh", () => {
  it("rescans only when file signatures change and only notifies metadata changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-skill-signature-"));
    const file = join(root, "base", "SKILL.md");
    let revision = 0;
    const write = async (description: string, body: string): Promise<void> => {
      await mkdir(join(root, "base"), { recursive: true });
      await writeFile(
        file,
        `---\nname: base\ndescription: ${description}\n---\n${body}`,
      );
      const stamp = new Date(Date.now() + ++revision * 1000);
      await utimes(file, stamp, stamp);
    };
    try {
      await write("First description", "First body");
      const loader = new SkillLoader({
        directories: [{ path: root, scope: "project" }],
      });
      const scan = vi.spyOn(loader, "scan");
      const registry = new SkillRegistry({ loader });
      let changes = 0;
      registry.onChange(async () => {
        changes += 1;
        // Cached list reads inside consumers must never recursively refresh.
        expect(await registry.listNames()).toEqual(["base"]);
      });
      await registry.refresh();
      const firstChangeCount = changes;
      await registry.refresh();
      await registry.get("base");
      expect(scan).toHaveBeenCalledTimes(1);
      await write("First description", "Changed body");
      expect((await registry.load("base")).content).toContain("Changed body");
      expect(changes).toBe(firstChangeCount);
      await write("Changed description", "Changed body");
      expect((await registry.get("base"))?.description).toBe(
        "Changed description",
      );
      expect(changes).toBe(firstChangeCount + 1);
      await registry.refresh();
      expect(scan).toHaveBeenCalledTimes(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Skill notification failures", () => {
  it("consumes rejected consumers from both synchronous plugin notification entry points", async () => {
    const moduleUrl = new URL("./registry.ts", import.meta.url).href;
    const script = `
      const { SkillRegistry } = await import(${JSON.stringify(moduleUrl)});
      const unhandled = [];
      process.on("unhandledRejection", (error) => { unhandled.push(error.message); });
      const registry = new SkillRegistry();
      registry.onChange(() => Promise.reject(new Error("consumer refresh failed")));
      registry.registerPluginSkills("fixture", []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      registry.deregisterPlugin("fixture");
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.stdout.write(JSON.stringify(unhandled));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
    ]);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it.each(["refresh", "reload"] as const)(
    "propagates an awaited %s consumer failure",
    async (method) => {
      const registry = new SkillRegistry({
        loader: {
          scan: (): Promise<Map<string, SkillInfo>> =>
            Promise.resolve(new Map([[baseSkill.name, baseSkill]])),
          loadContent: (info): Promise<SkillContent> =>
            Promise.resolve(makeContent(info)),
        },
      });
      registry.onChange(() =>
        Promise.reject(new Error("awaited consumer failed")),
      );
      await expect(registry[method]()).rejects.toThrow(
        "awaited consumer failed",
      );
    },
  );
});
