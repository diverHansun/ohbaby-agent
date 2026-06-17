import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setEnvFileValue } from "../llm/env-file.js";
import { ConfigError } from "../llm/types.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";

export interface GlobalEnvSecretWriteOptions {
  readonly homeDirectory?: string;
}

export async function writeEnvSecret(
  envPath: string,
  key: string,
  value: string,
): Promise<string> {
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `Failed to read .env file: ${(error as Error).message}`,
        "LOAD_FAILED",
        { path: envPath, cause: error },
      );
    }
  }

  await writeFileAtomically(envPath, setEnvFileValue(content, key, value));
  return envPath;
}

export async function writeGlobalEnvSecret(
  key: string,
  value: string,
  options: GlobalEnvSecretWriteOptions = {},
): Promise<string> {
  const envPath = getGlobalEnvPath(options.homeDirectory);
  return writeEnvSecret(envPath, key, value);
}

async function writeFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${String(process.pid)}-${String(Date.now())}`;
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}
