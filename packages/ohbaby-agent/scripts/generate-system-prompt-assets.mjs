import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const promptRoot = join(packageRoot, "src", "core", "system-prompt", "prompts");
const outputPath = join(promptRoot, "templates.generated.ts");
const checkOnly = process.argv.includes("--check");

const templates = [
  {
    exportName: "PRIMARY_BASE_PROMPT_TEMPLATE",
    path: "primary/base.md",
  },
  {
    exportName: "SUBAGENT_ROLES_GUIDANCE_PROMPT_TEMPLATE",
    path: "primary/subagent-roles.md",
  },
  {
    exportName: "PRIMARY_TASK_AGENT_PROMPT_TEMPLATE",
    path: "primary/tasks/agent.md",
  },
  {
    exportName: "PRIMARY_TASK_PLAN_PROMPT_TEMPLATE",
    path: "primary/tasks/plan.md",
  },
  {
    exportName: "SUBAGENT_BASE_PROMPT_TEMPLATE",
    path: "subagents/base.md",
  },
  {
    exportName: "SUBAGENT_TASK_EXPLORE_PROMPT_TEMPLATE",
    path: "subagents/tasks/explore.md",
  },
  {
    exportName: "SUBAGENT_TASK_GENERIC_PROMPT_TEMPLATE",
    path: "subagents/tasks/generic.md",
  },
  {
    exportName: "SUBAGENT_TASK_RESEARCH_PROMPT_TEMPLATE",
    path: "subagents/tasks/research.md",
  },
];

function normalizePromptTemplate(content) {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
}

function normalizeLineEndings(content) {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const lines = [
  "// Generated from .md prompt assets. Do not edit by hand.",
  "// Run: node packages/ohbaby-agent/scripts/generate-system-prompt-assets.mjs",
  "",
];

for (const template of templates) {
  const content = await readFile(join(promptRoot, template.path), "utf8");
  lines.push(
    `export const ${template.exportName} =\n  ${JSON.stringify(
      normalizePromptTemplate(content),
    )};`,
  );
}

const output = `${lines.join("\n")}\n`;

if (checkOnly) {
  const current = normalizeLineEndings(await readFile(outputPath, "utf8"));
  if (current !== output) {
    console.error(
      "System prompt templates are out of date. Run: pnpm --filter ohbaby-agent prompt:generate",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output, "utf8");
}
