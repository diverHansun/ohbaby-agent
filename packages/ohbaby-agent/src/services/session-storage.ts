import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolExecutionEnvironment } from "../core/tool-scheduler/types.js";
import { TOOL_RESULTS_DIR } from "../paths/session-storage.js";
import {
  CappedOutputFile,
  type OutputFileSnapshot,
} from "../utils/capped-output-file.js";

/** Use the already prepared owner root; execution session IDs can belong to a child. */
export async function prepareToolOutputDirectory(
  environment?: Pick<ToolExecutionEnvironment, "trustedRoots">,
): Promise<string | undefined> {
  try {
    const root = environment
      ?.trustedRoots?.()
      .find((root) => root.kind === "session-storage")?.path;
    if (
      !root ||
      !(await fs.lstat(root)).isDirectory() ||
      (await fs.realpath(root)) !== root
    )
      return undefined;
    const directory = path.join(root, TOOL_RESULTS_DIR);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    });
    return await validate(directory);
  } catch {
    return undefined;
  }
  async function validate(directory: string): Promise<string | undefined> {
    if (
      !(await fs.lstat(directory)).isDirectory() ||
      (await fs.realpath(directory)) !== directory
    )
      return undefined;
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);
    return directory;
  }
}

export async function writeToolOutput(input: {
  readonly environment?: Pick<ToolExecutionEnvironment, "trustedRoots">;
  readonly callId: string;
  readonly text: string;
}): Promise<OutputFileSnapshot> {
  const directory = await prepareToolOutputDirectory(input.environment);
  if (!directory) return { status: "unavailable" };
  const stem =
    input.callId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128) || "call";
  const file = new CappedOutputFile(
    path.join(directory, `${stem}-${randomUUID()}.txt`),
  );
  file.append(Buffer.from(input.text, "utf8"));
  file.finish(true);
  return file.snapshot();
}
