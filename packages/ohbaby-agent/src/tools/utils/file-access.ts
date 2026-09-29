import { resolveWritablePreview } from "./text-files.js";
import fs from "node:fs/promises";
import path from "node:path";
import { withToolAdmission } from "../../core/tool-scheduler/tool-admission.js";
import type { ResourceAccess } from "../../core/tool-scheduler/resources.js";
import type {
  Tool,
  ToolExecutionContext,
} from "../../core/tool-scheduler/types.js";
import {
  canonicalizePathTarget,
  canonicalizeResourcePath,
} from "../../utils/path-canonicalize.js";
import { resolvePath, resolvePathForExisting } from "./context.js";
import { getStringParam } from "./params.js";

const displayPath = Symbol("file access display path");
export function fileDisplayPath(
  params: Record<string, unknown>,
  fallback: string,
): string {
  const display: unknown = Reflect.get(params, displayPath);
  return typeof display === "string" ? display : fallback;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function readTarget(
  context: ToolExecutionContext,
  value: string,
): Promise<string> {
  try {
    return await resolvePathForExisting(context, value);
  } catch (error) {
    if (!isMissing(error)) throw error;
    // A cooperating writer may own an as-yet missing target. Validate the
    // boundary now, and leave existence/content checks inside the resource lease.
    const target = await canonicalizePathTarget(resolvePath(context, value));
    return resolvePath(context, target);
  }
}

type FileAccessKind = "read" | "write" | "tree" | "search";
export function withFileAccess(tool: Tool, kind: FileAccessKind): Tool {
  const param = kind === "read" || kind === "write" ? "file_path" : "path";
  function input(params: Record<string, unknown>): string {
    return params[param] === undefined && param === "path"
      ? "."
      : getStringParam(params, param);
  }
  function resource(target: string, tree: boolean): ResourceAccess {
    return {
      kind: "file",
      path: target,
      scope: tree ? "tree" : "file",
      mode: kind === "write" ? "write" : "read",
    };
  }
  return withToolAdmission(tool, {
    async plan(params, context) {
      const value = input(params);
      // This permissive identity lookup tolerates targets created by predecessors.
      // Search uses a conservative tree until its actual position in the batch.
      const lexical = context.environment
        ? path.resolve(context.environment.workdir, value)
        : resolvePath(context, value);
      return [
        resource(
          await canonicalizeResourcePath(lexical),
          kind === "tree" || kind === "search",
        ),
      ];
    },
    async resolve(params, context: ToolExecutionContext) {
      const target =
        kind === "write"
          ? await resolveWritablePreview(context, input(params))
          : await readTarget(context, input(params));
      const tree =
        kind === "tree" ||
        (kind === "search" &&
          (await fs.stat(target).then(
            (stats) => stats.isDirectory(),
            (error: unknown) => {
              if (isMissing(error)) return true;
              throw error;
            },
          )));
      return {
        resources: [resource(target, tree)],
        params: {
          ...params,
          [displayPath]: fileDisplayPath(params, input(params)),
          [param]: target,
        },
      };
    },
  });
}
