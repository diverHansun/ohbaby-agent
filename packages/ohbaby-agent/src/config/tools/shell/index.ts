import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveOhbabyHome } from "../../../paths/index.js";

const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DEFAULT_AUTO_BACKGROUND = true;
export const DEFAULT_FOREGROUND_WAIT_MS = 120_000;
export const MAX_FOREGROUND_WAIT_MS = 600_000;

const ShellConfigSchema = z
  .object({
    autoBackground: z.boolean().default(DEFAULT_AUTO_BACKGROUND),
    defaultForegroundWaitMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_FOREGROUND_WAIT_MS)
      .default(DEFAULT_FOREGROUND_WAIT_MS),
    maxRunningBackgroundJobs: limit.default(10),
    maxRunningSubagentBackgroundJobs: limit.default(5),
  })
  .strict();

export type ShellConfig = z.infer<typeof ShellConfigSchema>;

/** Load once when constructing a runtime; no watcher or second settings store. */
export async function loadShellConfig(
  file = path.join(resolveOhbabyHome(), "tools", "shell.json"),
): Promise<ShellConfig> {
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return ShellConfigSchema.parse({});
    throw new Error(`Failed to read shell configuration: ${file}`, {
      cause: error,
    });
  }
  try {
    const raw: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
    return ShellConfigSchema.parse(raw);
  } catch (error) {
    throw new Error(`Invalid shell configuration: ${file}`, { cause: error });
  }
}
