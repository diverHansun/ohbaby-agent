import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { PRIMARY_BASE_PROMPT } from "../prompts/primary/base.js";
import { getPrimaryTaskPrompt } from "../prompts/primary/tasks.js";
import { SUBAGENT_BASE_PROMPT } from "../prompts/subagents/base.js";
import { getSubagentTaskPrompt } from "../prompts/subagents/tasks.js";

function normalizeAssetText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
}

function readPromptAsset(relativePath: string): string {
  return normalizeAssetText(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  );
}

describe("system prompt template assets", () => {
  const promptAssets = [
    {
      exported: PRIMARY_BASE_PROMPT,
      path: "../prompts/primary/base.md",
    },
    {
      exported: getPrimaryTaskPrompt("ask"),
      path: "../prompts/primary/tasks/ask.md",
    },
    {
      exported: getPrimaryTaskPrompt("plan"),
      path: "../prompts/primary/tasks/plan.md",
    },
    {
      exported: getPrimaryTaskPrompt("agent"),
      path: "../prompts/primary/tasks/agent.md",
    },
    {
      exported: SUBAGENT_BASE_PROMPT,
      path: "../prompts/subagents/base.md",
    },
    {
      exported: getSubagentTaskPrompt("explore"),
      path: "../prompts/subagents/tasks/explore.md",
    },
    {
      exported: getSubagentTaskPrompt("research"),
      path: "../prompts/subagents/tasks/research.md",
    },
    {
      exported: getSubagentTaskPrompt("generic"),
      path: "../prompts/subagents/tasks/generic.md",
    },
  ] as const;

  it.each(promptAssets)(
    "uses $path as the prompt source",
    ({ exported, path }) => {
      const assetText = readPromptAsset(path);

      expect(assetText.trim()).not.toBe("");
      expect(exported).toBe(assetText);
    },
  );
});
