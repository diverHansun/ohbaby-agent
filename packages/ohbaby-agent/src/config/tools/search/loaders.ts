import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SearchConfigError } from "./types.js";

export const OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent";
export const TOOLS_CONFIG_DIR_NAME = "tools";
export const SEARCH_CONFIG_FILE_NAME = "search.json";

export function getSearchJsonPath(homeDirectory = os.homedir()): string {
  return path.join(
    homeDirectory,
    OHBABY_CONFIG_DIR_NAME,
    TOOLS_CONFIG_DIR_NAME,
    SEARCH_CONFIG_FILE_NAME,
  );
}

export async function loadSearchJson(
  searchJsonPath = getSearchJsonPath(),
): Promise<unknown> {
  let content: string;
  try {
    content = await fs.readFile(searchJsonPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new SearchConfigError({
      code: "LOAD_FAILED",
      message: `Failed to read search configuration: ${searchJsonPath}`,
      path: searchJsonPath,
      cause: error,
    });
  }

  try {
    return JSON.parse(stripUtf8Bom(content));
  } catch (error) {
    throw new SearchConfigError({
      code: "INVALID_JSON",
      message: `Invalid JSON in search configuration: ${searchJsonPath}`,
      path: searchJsonPath,
      cause: error,
    });
  }
}

function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
