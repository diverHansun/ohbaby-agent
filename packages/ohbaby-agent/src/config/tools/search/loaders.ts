import fs from "node:fs/promises";
import path from "node:path";
import {
  OHBABY_DIR_NAME,
  resolveLegacyOhbabyHome,
  resolveOhbabyHome,
  resolveReadPathWithLegacy,
} from "../../../paths/index.js";
import { SearchConfigError } from "./types.js";

export const OHBABY_CONFIG_DIR_NAME = OHBABY_DIR_NAME;
export const TOOLS_CONFIG_DIR_NAME = "tools";
export const SEARCH_CONFIG_FILE_NAME = "search.json";

export function getSearchJsonPath(homeDirectory?: string): string {
  return path.join(
    resolveOhbabyHome({ homeDirectory }),
    TOOLS_CONFIG_DIR_NAME,
    SEARCH_CONFIG_FILE_NAME,
  );
}

function getLegacySearchJsonPath(homeDirectory?: string): string {
  return path.join(
    resolveLegacyOhbabyHome({ homeDirectory }),
    TOOLS_CONFIG_DIR_NAME,
    SEARCH_CONFIG_FILE_NAME,
  );
}

export async function loadSearchJson(
  searchJsonPath?: string,
): Promise<unknown> {
  const resolvedPath =
    searchJsonPath ??
    (await resolveReadPathWithLegacy(getSearchJsonPath(), [
      getLegacySearchJsonPath(),
    ]));
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new SearchConfigError({
      code: "LOAD_FAILED",
      message: `Failed to read search configuration: ${resolvedPath}`,
      path: resolvedPath,
      cause: error,
    });
  }

  try {
    return JSON.parse(stripUtf8Bom(content));
  } catch (error) {
    throw new SearchConfigError({
      code: "INVALID_JSON",
      message: `Invalid JSON in search configuration: ${resolvedPath}`,
      path: resolvedPath,
      cause: error,
    });
  }
}

function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
