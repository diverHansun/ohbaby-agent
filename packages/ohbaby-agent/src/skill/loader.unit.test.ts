import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLoader, getGlobalSkillDirectory } from "./loader.js";

let tempDir: string;

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function skillFile(frontmatter: string, body = "# Skill\n\nUse this."): string {
  return `---\n${frontmatter.trim()}\n---\n\n${body}\n`;
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-skill-loader-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("SkillLoader", () => {
  it("uses the platform config directory for global skills", () => {
    const homeDirectory = path.join(tempDir, "home");
    const appDataDirectory = path.join(tempDir, "appdata");
    const xdgConfigDirectory = path.join(tempDir, "xdg");

    const directory = getGlobalSkillDirectory(homeDirectory, {
      APPDATA: appDataDirectory,
      XDG_CONFIG_HOME: xdgConfigDirectory,
    });

    expect(directory).toBe(
      path.join(
        process.platform === "win32" ? appDataDirectory : xdgConfigDirectory,
        "ohbaby-agent",
        "skill",
      ),
    );
  });

  it("discovers SKILL.md directories, applies defaults, and lets project skills override user skills", async () => {
    const userDir = path.join(tempDir, "user", "skill");
    const projectDir = path.join(tempDir, "project", ".ohbaby-agent", "skill");
    await writeFile(
      path.join(userDir, "review", "SKILL.md"),
      skillFile("name: code-review\ndescription: User review guidance"),
    );
    await writeFile(
      path.join(projectDir, "review", "SKILL.md"),
      skillFile(
        "name: code-review\ndescription: Project review guidance\nuser-invocable: false",
      ),
    );
    await writeFile(
      path.join(projectDir, "deep", "nested", "SKILL.md"),
      skillFile(
        "name: nested-skill\ndescription: Nested skill\ndisable-model-invocation: true",
      ),
    );

    const warnings: string[] = [];
    const loader = new SkillLoader({
      directories: [
        { path: userDir, scope: "user" },
        { path: projectDir, scope: "project" },
      ],
      logger: {
        warn(message): void {
          warnings.push(message);
        },
      },
    });

    const skills = await loader.scan();

    expect([...skills.keys()].sort()).toEqual(["code-review", "nested-skill"]);
    expect(skills.get("code-review")).toMatchObject({
      description: "Project review guidance",
      disableModelInvocation: false,
      scope: "project",
      userInvocable: false,
    });
    expect(skills.get("nested-skill")).toMatchObject({
      disableModelInvocation: true,
      scope: "project",
      userInvocable: true,
    });
    expect(warnings.some((message) => message.includes("overrides"))).toBe(
      true,
    );
  });

  it("skips invalid files without stopping the scan", async () => {
    const skillDir = path.join(tempDir, "project", ".ohbaby-agent", "skill");
    await writeFile(
      path.join(skillDir, "valid", "SKILL.md"),
      skillFile("name: valid-skill\ndescription: A valid skill"),
    );
    await writeFile(
      path.join(skillDir, "missing-name", "SKILL.md"),
      skillFile("description: Missing name"),
    );
    await writeFile(
      path.join(skillDir, "bad-name", "SKILL.md"),
      skillFile("name: Bad_Name\ndescription: Bad name"),
    );
    await writeFile(
      path.join(skillDir, "plain", "SKILL.md"),
      "# Missing frontmatter",
    );

    const warnings: string[] = [];
    const loader = new SkillLoader({
      directories: [{ path: skillDir, scope: "project" }],
      logger: {
        warn(message): void {
          warnings.push(message);
        },
      },
    });

    const skills = await loader.scan();

    expect([...skills.keys()]).toEqual(["valid-skill"]);
    expect(warnings).toHaveLength(3);
  });

  it("loads markdown content and lists non-hidden helper files with portable paths", async () => {
    const skillDir = path.join(tempDir, "project", ".ohbaby-agent", "skill");
    const baseDir = path.join(skillDir, "xlsx");
    await writeFile(
      path.join(baseDir, "SKILL.md"),
      skillFile("name: xlsx\ndescription: Spreadsheet helpers", "# XLSX\n"),
    );
    await writeFile(path.join(baseDir, "read-xlsx.ts"), "export {}\n");
    await writeFile(path.join(baseDir, ".secret"), "hidden\n");
    await writeFile(path.join(baseDir, "templates", "sheet.json"), "{}\n");

    const loader = new SkillLoader({
      directories: [{ path: skillDir, scope: "project" }],
    });
    const skill = (await loader.scan()).get("xlsx");
    if (!skill) {
      throw new Error("expected xlsx skill");
    }

    const content = await loader.loadContent(skill);

    expect(content.content.trim()).toBe("# XLSX");
    expect(content.baseDir).toBe(baseDir);
    expect(content.files).toEqual(["read-xlsx.ts", "templates/sheet.json"]);
  });

  it("does not follow symlinked directories while discovering skills", async () => {
    const skillDir = path.join(tempDir, "project", ".ohbaby-agent", "skill");
    const externalDir = path.join(tempDir, "outside-skill");
    await writeFile(
      path.join(externalDir, "SKILL.md"),
      skillFile("name: external-skill\ndescription: Outside skill"),
    );
    await fs.mkdir(skillDir, { recursive: true });

    try {
      await fs.symlink(
        externalDir,
        path.join(skillDir, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return;
    }

    const loader = new SkillLoader({
      directories: [{ path: skillDir, scope: "project" }],
    });

    const skills = await loader.scan();

    expect([...skills.keys()]).toEqual([]);
  });
});
