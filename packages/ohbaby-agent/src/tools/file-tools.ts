import fs from "node:fs/promises";
import path from "node:path";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { formatWithLineNumbers } from "../utils/index.js";
import {
  createGlobMatcher,
  ensureWritableParent,
  isProbablyBinary,
  splitTextLines,
  walkFiles,
} from "./utils/files.js";
import {
  getBooleanParam,
  getNumberParam,
  getOptionalStringParam,
  getStringArrayParam,
  getStringParam,
  ToolParameterError,
} from "./utils/params.js";
import { renderList, renderReplacementDiff, truncateOutput } from "./utils/output.js";
import {
  resolvePathForExisting,
  resolvePathForWrite,
} from "./utils/context.js";

const DEFAULT_READ_LIMIT = 2_000;
const DEFAULT_SEARCH_LIMIT = 100;

const FILE_PATH_SCHEMA = {
  type: "string",
  description: "Path relative to the tool execution workspace.",
};

async function readTextFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  if (isProbablyBinary(buffer)) {
    throw new Error(`Refusing to read binary file: ${filePath}`);
  }

  return buffer.toString("utf8");
}

async function resolveWritableFile(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<string> {
  await ensureWritableParent(context, inputPath);
  const writePath = await resolvePathForWrite(context, inputPath);
  try {
    await fs.lstat(writePath);
    return await resolvePathForExisting(context, inputPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return writePath;
    }
    throw error;
  }
}

function createReadTool(): Tool {
  return {
    name: "read",
    description: "Read a text file from the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        file_path: FILE_PATH_SCHEMA,
        limit: { minimum: 1, type: "integer" },
        offset: { minimum: 1, type: "integer" },
      },
      required: ["file_path"],
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getStringParam(params, "file_path");
      const offset = getNumberParam(params, "offset", {
        defaultValue: 1,
        integer: true,
        min: 1,
      });
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_READ_LIMIT,
        integer: true,
        min: 1,
      });
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${inputPath}`);
      }
      const content = await readTextFile(resolvedPath);
      const lines = splitTextLines(content);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const output = formatWithLineNumbers(selected, { startLine: offset });

      return {
        output: truncateOutput(output),
        metadata: {
          lineCount: lines.length,
          path: resolvedPath,
          shownLineCount: selected.length,
        },
      };
    },
  };
}

function createListTool(): Tool {
  return {
    name: "list",
    description: "List immediate files and directories in the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        ignore: { items: { type: "string" }, type: "array" },
        limit: { minimum: 1, type: "integer" },
        path: FILE_PATH_SCHEMA,
      },
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getOptionalStringParam(params, "path") ?? ".";
      const ignore = new Set(getStringArrayParam(params, "ignore"));
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_SEARCH_LIMIT,
        integer: true,
        min: 1,
      });
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const visible = entries
        .filter((entry) => !ignore.has(entry.name))
        .filter((entry) => ![".git", "node_modules", "dist"].includes(entry.name))
        .sort((first, second) => first.name.localeCompare(second.name));
      const lines = visible.slice(0, limit).map((entry) => {
        return entry.isDirectory() ? `${entry.name}/` : entry.name;
      });
      const truncated = visible.length > limit;
      if (truncated) {
        lines.push(`... (${String(visible.length - limit)} more entries)`);
      }

      return {
        output: renderList(lines, "Directory is empty."),
        metadata: { count: Math.min(visible.length, limit), truncated },
      };
    },
  };
}

function createGlobTool(): Tool {
  return {
    name: "glob",
    description: "Find files by glob pattern inside the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        limit: { minimum: 1, type: "integer" },
        path: FILE_PATH_SCHEMA,
        pattern: { type: "string" },
      },
      required: ["pattern"],
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(params, context): Promise<ToolExecutionResult> {
      const pattern = getStringParam(params, "pattern");
      const inputPath = getOptionalStringParam(params, "path") ?? ".";
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_SEARCH_LIMIT,
        integer: true,
        min: 1,
      });
      const matcher = createGlobMatcher(pattern);
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const walked = await walkFiles({ basePath: resolvedPath, limit: limit * 5 });
      const matches = walked.files
        .filter((file) => matcher(file.relativePath))
        .slice(0, limit)
        .map((file) => file.relativePath);
      const truncated = walked.truncated || matches.length >= limit;

      return {
        output: renderList(matches, "No files matched."),
        metadata: { count: matches.length, truncated },
      };
    },
  };
}

function createGrepTool(): Tool {
  return {
    name: "grep",
    description: "Search text files by regular expression inside the workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        include: { type: "string" },
        limit: { minimum: 1, type: "integer" },
        path: FILE_PATH_SCHEMA,
        pattern: { type: "string" },
      },
      required: ["pattern"],
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(params, context): Promise<ToolExecutionResult> {
      const pattern = getStringParam(params, "pattern");
      const include = getOptionalStringParam(params, "include") ?? "**/*";
      const inputPath = getOptionalStringParam(params, "path") ?? ".";
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_SEARCH_LIMIT,
        integer: true,
        min: 1,
      });
      const regex = new RegExp(pattern, "u");
      const includeMatcher = createGlobMatcher(include);
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const walked = await walkFiles({ basePath: resolvedPath, limit: limit * 20 });
      const matches: string[] = [];
      for (const file of walked.files) {
        if (!includeMatcher(file.relativePath)) {
          continue;
        }
        const buffer = await fs.readFile(file.absolutePath);
        if (isProbablyBinary(buffer)) {
          continue;
        }
        const lines = splitTextLines(buffer.toString("utf8"));
        for (const [index, line] of lines.entries()) {
          if (regex.test(line)) {
            matches.push(`${file.relativePath}:${String(index + 1)}: ${line}`);
            if (matches.length >= limit) {
              break;
            }
          }
        }
        if (matches.length >= limit) {
          break;
        }
      }

      return {
        output: renderList(matches, "No matches found."),
        metadata: {
          count: matches.length,
          truncated: walked.truncated || matches.length >= limit,
        },
      };
    },
  };
}

function createWriteTool(): Tool {
  return {
    name: "write",
    description: "Write a text file inside the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        content: { type: "string" },
        file_path: FILE_PATH_SCHEMA,
      },
      required: ["file_path", "content"],
      type: "object",
    },
    source: "builtin",
    category: "write",
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getStringParam(params, "file_path");
      const content = getStringParam(params, "content", { allowEmpty: true });
      const resolvedPath = await resolveWritableFile(context, inputPath);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, "utf8");

      return {
        output: `Wrote ${String(Buffer.byteLength(content, "utf8"))} bytes to ${inputPath}.`,
        metadata: { bytes: Buffer.byteLength(content, "utf8"), path: resolvedPath },
      };
    },
  };
}

function createEditTool(): Tool {
  return {
    name: "edit",
    description: "Replace text in an existing workspace file.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        file_path: FILE_PATH_SCHEMA,
        new_string: { type: "string" },
        old_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
      type: "object",
    },
    source: "builtin",
    category: "write",
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getStringParam(params, "file_path");
      const oldString = getStringParam(params, "old_string");
      const newString = getStringParam(params, "new_string", { allowEmpty: true });
      const replaceAll = getBooleanParam(params, "replace_all", false);
      const existingPath = await resolvePathForExisting(context, inputPath);
      const writePath = await resolveWritableFile(context, inputPath);
      const content = await readTextFile(existingPath);
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error(`No occurrences found for edit target in ${inputPath}.`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new ToolParameterError(
          `Found ${String(occurrences)} occurrences; set replace_all to true.`,
        );
      }
      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      await fs.writeFile(writePath, updated, "utf8");

      return {
        output: renderReplacementDiff({
          newString,
          oldString,
          replacementCount: replaceAll ? occurrences : 1,
        }),
        metadata: {
          path: writePath,
          replacementCount: replaceAll ? occurrences : 1,
        },
      };
    },
  };
}

export function createFileTools(): Tool[] {
  return [
    createReadTool(),
    createListTool(),
    createGlobTool(),
    createGrepTool(),
    createWriteTool(),
    createEditTool(),
  ];
}
