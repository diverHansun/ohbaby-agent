import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import {
  createPermissionManager,
  createPermissionState,
} from "../../../packages/ohbaby-agent/src/permission/index.js";
import { AdapterRegistry } from "../../../packages/ohbaby-agent/src/sandbox/adapter-registry.js";
import { HostLocalAdapter } from "../../../packages/ohbaby-agent/src/sandbox/adapters/host-local.js";
import { SandboxManager } from "../../../packages/ohbaby-agent/src/sandbox/manager.js";
import { createSkillTool } from "../../../packages/ohbaby-agent/src/skill/tool.js";
import type {
  SkillContent,
  SkillInfo,
} from "../../../packages/ohbaby-agent/src/skill/types.js";
import { createBashTool } from "../../../packages/ohbaby-agent/src/tools/bash.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-skill-sandbox-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { force: true, recursive: true });
});

function createSandboxManager(): SandboxManager {
  const registry = new AdapterRegistry();
  registry.register(new HostLocalAdapter());
  return new SandboxManager({ adapterRegistry: registry });
}

function createSkillInfo(skillRoot: string): SkillInfo {
  return {
    allowedTools: [],
    baseDir: skillRoot,
    description: "External skill used by sandbox integration tests.",
    disableModelInvocation: false,
    frontmatter: {
      description: "External skill used by sandbox integration tests.",
      name: "external-script",
    },
    location: path.join(skillRoot, "SKILL.md"),
    metadata: {},
    name: "external-script",
    scope: "user",
    source: "user",
    userInvocable: true,
  };
}

function createSkillContent(info: SkillInfo): SkillContent {
  return {
    baseDir: info.baseDir,
    content: "# External script\n\nRun the helper script.",
    files: ["scripts/marker.js"],
    info,
  };
}

describe("skill shell sandbox integration", () => {
  it("lets an activated external skill root execute through bash", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const skillRoot = path.join(tempRoot, "skills", "external-script");
    const script = path.join(skillRoot, "scripts", "marker.js");
    await fs.mkdir(workspace);
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "# External script\n",
      "utf8",
    );
    await fs.writeFile(
      script,
      "console.log('OHBABY_SKILL_SCRIPT_OK')\n",
      "utf8",
    );

    const info = createSkillInfo(skillRoot);
    const bus = createBus();
    const permissionState = createPermissionState({
      bus,
      initialLevel: "full-access",
    });
    const permission = createPermissionManager({ bus, state: permissionState });
    const askSpy = vi.spyOn(permission, "ask");
    const scheduler = createToolScheduler({ bus, permission, permissionState });
    const sandboxManager = createSandboxManager();
    await sandboxManager.createContext("session_1", {
      adapterId: "host-local",
      workdir: workspace,
    });
    const lease = await sandboxManager.acquire("session_1");

    scheduler.register(
      await createSkillTool({
        get: () => Promise.resolve(info),
        listModelInvocable: () => Promise.resolve([info]),
        load: () => Promise.resolve(createSkillContent(info)),
      }),
    );
    scheduler.register(createBashTool());

    try {
      await expect(
        scheduler.execute({
          callId: "load_skill",
          environment: lease,
          messageId: "message_1",
          params: { name: "external-script" },
          sessionId: "session_1",
          toolName: "skill",
        }),
      ).resolves.toMatchObject({
        metadata: { dir: skillRoot },
        status: "success",
      });

      expect(lease.containsTrustedPath(await fs.realpath(script))).toBe(true);
      await expect(
        scheduler.execute({
          callId: "run_skill_script",
          environment: lease,
          messageId: "message_1",
          params: { command: `node ${JSON.stringify(script)}` },
          sessionId: "session_1",
          toolName: "bash",
        }),
      ).resolves.toMatchObject({
        output: expect.stringContaining("OHBABY_SKILL_SCRIPT_OK"),
        status: "success",
      });
      expect(askSpy).not.toHaveBeenCalled();
    } finally {
      await sandboxManager.release(lease);
    }
  });
});
