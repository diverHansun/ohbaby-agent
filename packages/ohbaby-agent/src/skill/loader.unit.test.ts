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

function warningError(context: Record<string, unknown> | undefined): string {
  const error = context?.error;
  return typeof error === "string" ? error : "";
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

  it("requires non-empty markdown instructions after frontmatter", async () => {
    const skillDir = path.join(tempDir, "project", ".ohbaby-agent", "skill");
    await writeFile(
      path.join(skillDir, "empty", "SKILL.md"),
      skillFile("name: empty-skill\ndescription: Empty body", "   \n\t"),
    );

    const warnings: string[] = [];
    const loader = new SkillLoader({
      directories: [{ path: skillDir, scope: "project" }],
      logger: {
        warn(message, context): void {
          warnings.push(`${message}:${warningError(context)}`);
        },
      },
    });

    const skills = await loader.scan();

    expect([...skills.keys()]).toEqual([]);
    expect(warnings.join("\n")).toContain("Skill body is required");
  });

  it("preserves standard metadata and warns about invalid optional fields without skipping", async () => {
    const skillDir = path.join(tempDir, "project", ".ohbaby-agent", "skill");
    await writeFile(
      path.join(skillDir, "standard", "SKILL.md"),
      skillFile(`name: standard-skill
description: Standard metadata
license: MIT
allowed-tools:
  - read
  - grep
metadata:
  audience: maintainers
  workflow: review
x-vendor-field: kept`),
    );
    await writeFile(
      path.join(skillDir, "optional", "SKILL.md"),
      skillFile(`name: optional-skill
description: Invalid optional fields still load
user-invocable: maybe
disable-model-invocation: also-maybe
allowed-tools:
  nested: invalid
metadata: wrong`),
    );

    const warnings: string[] = [];
    const loader = new SkillLoader({
      directories: [{ path: skillDir, scope: "project" }],
      logger: {
        warn(message, context): void {
          warnings.push(`${message}:${warningError(context)}`);
        },
      },
    });

    const skills = await loader.scan();

    expect([...skills.keys()].sort()).toEqual([
      "optional-skill",
      "standard-skill",
    ]);
    expect(skills.get("standard-skill")).toMatchObject({
      allowedTools: ["read", "grep"],
      license: "MIT",
      metadata: { audience: "maintainers", workflow: "review" },
      source: "project-native",
    });
    expect(skills.get("standard-skill")?.frontmatter).toMatchObject({
      "x-vendor-field": "kept",
    });
    expect(skills.get("optional-skill")).toMatchObject({
      allowedTools: [],
      disableModelInvocation: false,
      metadata: {},
      userInvocable: true,
    });
    expect(warnings.join("\n")).toContain("Invalid optional skill field");
  });

  it("discovers native, compatible, and Codex home skill directories with deterministic precedence", async () => {
    const homeDirectory = path.join(tempDir, "home");
    const codexHome = path.join(tempDir, "codex-home");
    const projectRoot = path.join(tempDir, "project");

    await writeFile(
      path.join(codexHome, "skills", "codex-skill", "SKILL.md"),
      skillFile("name: codex-skill\ndescription: Codex home skill"),
    );
    await writeFile(
      path.join(projectRoot, ".claude", "skills", "claude-skill", "SKILL.md"),
      skillFile("name: claude-skill\ndescription: Claude compatible skill"),
    );
    await writeFile(
      path.join(projectRoot, ".agents", "skills", "agent-skill", "SKILL.md"),
      skillFile("name: agent-skill\ndescription: Agents compatible skill"),
    );
    await writeFile(
      path.join(
        projectRoot,
        ".ohbaby-agent",
        "skills",
        "native-skill",
        "SKILL.md",
      ),
      skillFile("name: native-skill\ndescription: Native plural skill"),
    );
    await writeFile(
      path.join(codexHome, "skills", "shared", "SKILL.md"),
      skillFile("name: shared-skill\ndescription: Codex shared"),
    );
    await writeFile(
      path.join(projectRoot, ".ohbaby-agent", "skill", "shared", "SKILL.md"),
      skillFile("name: shared-skill\ndescription: Project native shared"),
    );

    const loader = new SkillLoader({
      environment: { CODEX_HOME: codexHome },
      homeDirectory,
      projectDirectory: projectRoot,
    });

    const skills = await loader.scan();

    expect([...skills.keys()].sort()).toEqual([
      "agent-skill",
      "claude-skill",
      "codex-skill",
      "native-skill",
      "shared-skill",
    ]);
    expect(skills.get("codex-skill")).toMatchObject({
      scope: "user",
      source: "codex-home",
    });
    expect(skills.get("claude-skill")).toMatchObject({
      scope: "project",
      source: "claude-compatible",
    });
    expect(skills.get("agent-skill")).toMatchObject({
      scope: "project",
      source: "agents-compatible",
    });
    expect(skills.get("native-skill")).toMatchObject({
      scope: "project",
      source: "project-native",
    });
    expect(skills.get("shared-skill")?.description).toBe(
      "Project native shared",
    );
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

  it("reads helper resources only from inside the skill directory", async () => {
    const skillDir = path.join(tempDir, "project", ".ohbaby-agent", "skill");
    const baseDir = path.join(skillDir, "docs");
    await writeFile(
      path.join(baseDir, "SKILL.md"),
      skillFile("name: docs-skill\ndescription: Docs skill"),
    );
    await writeFile(path.join(baseDir, "references", "guide.md"), "Guide\n");
    await writeFile(path.join(baseDir, ".secret"), "hidden\n");
    await writeFile(path.join(tempDir, "outside.md"), "outside\n");

    const loader = new SkillLoader({
      directories: [{ path: skillDir, scope: "project" }],
    });
    const skill = (await loader.scan()).get("docs-skill");
    if (!skill) {
      throw new Error("expected docs skill");
    }

    await expect(
      loader.readResource(skill, "references/guide.md"),
    ).resolves.toMatchObject({
      content: "Guide\n",
      path: "references/guide.md",
    });
    await expect(loader.readResource(skill, "../outside.md")).rejects.toThrow(
      /escapes skill directory|Invalid skill resource/u,
    );
    await expect(
      loader.readResource(skill, path.join(baseDir, "references", "guide.md")),
    ).rejects.toThrow(/absolute/u);
    await expect(loader.readResource(skill, ".secret")).rejects.toThrow(
      /hidden/u,
    );
    await expect(loader.readResource(skill, "SKILL.md")).rejects.toThrow(
      /SKILL\.md/u,
    );
    await expect(loader.readResource(skill, "references")).rejects.toThrow(
      /not a file/u,
    );
    try {
      await fs.symlink(
        path.join(tempDir, "outside.md"),
        path.join(baseDir, "references", "linked.md"),
        "file",
      );
      await expect(
        loader.readResource(skill, "references/linked.md"),
      ).rejects.toThrow(/symlinks/u);
    } catch {
      return;
    }
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
