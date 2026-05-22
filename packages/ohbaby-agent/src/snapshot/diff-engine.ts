import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  InvalidSnapshotArtifactError,
  type ComputedSnapshotPatch,
  type FileDiff,
  type FileDiffStatus,
  type SnapshotCheckpoint,
  type SnapshotDiffSummary,
  type SnapshotFilePatch,
  type SnapshotPatchArtifact,
  SnapshotBaselineNotFoundError,
} from "./types.js";

export interface DiffEngine {
  recordBaseline(checkpointId: string, workdir: string): Promise<void>;
  computeDiff(checkpoint: SnapshotCheckpoint): Promise<ComputedSnapshotPatch>;
  applyReverse(workdir: string, artifact: SnapshotPatchArtifact): Promise<void>;
}

type FileState = ReadonlyMap<string, Buffer>;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  "dist",
  "coverage",
]);

function toRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function resolveRelativePath(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/"));
  const relation = relative(root, target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new InvalidSnapshotArtifactError(
      `file path escapes workdir: ${relativePath}`,
    );
  }
  return target;
}

function contentToBase64(content: Buffer): string {
  return content.toString("base64");
}

function contentFromBase64(content: string | undefined): Buffer {
  if (content === undefined) {
    throw new InvalidSnapshotArtifactError("missing file content");
  }
  return Buffer.from(content, "base64");
}

async function collectFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(toRelativePath(root, path));
    }
  }

  return files.sort();
}

async function readFileState(workdir: string): Promise<FileState> {
  const state = new Map<string, Buffer>();
  for (const path of await collectFiles(workdir)) {
    state.set(path, await readFile(resolveRelativePath(workdir, path)));
  }
  return state;
}

function summarize(files: readonly FileDiff[]): SnapshotDiffSummary {
  return {
    added: files.filter((file) => file.status === "added").length,
    modified: files.filter((file) => file.status === "modified").length,
    deleted: files.filter((file) => file.status === "deleted").length,
  };
}

function createFilePatch(
  path: string,
  status: FileDiffStatus,
  before: Buffer | undefined,
  after: Buffer | undefined,
): SnapshotFilePatch {
  return {
    path,
    status,
    ...(before === undefined
      ? {}
      : { beforeContentBase64: contentToBase64(before) }),
    ...(after === undefined
      ? {}
      : { afterContentBase64: contentToBase64(after) }),
  };
}

function parseFilePatch(input: unknown): SnapshotFilePatch {
  if (typeof input !== "object" || input === null) {
    throw new InvalidSnapshotArtifactError("file patch must be an object");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.path !== "string") {
    throw new InvalidSnapshotArtifactError("file patch path must be a string");
  }
  if (
    value.status !== "added" &&
    value.status !== "modified" &&
    value.status !== "deleted"
  ) {
    throw new InvalidSnapshotArtifactError("file patch status is invalid");
  }
  if (
    value.beforeContentBase64 !== undefined &&
    typeof value.beforeContentBase64 !== "string"
  ) {
    throw new InvalidSnapshotArtifactError(
      "beforeContentBase64 must be a string",
    );
  }
  if (
    value.afterContentBase64 !== undefined &&
    typeof value.afterContentBase64 !== "string"
  ) {
    throw new InvalidSnapshotArtifactError(
      "afterContentBase64 must be a string",
    );
  }
  return {
    path: value.path,
    status: value.status,
    ...(value.beforeContentBase64 === undefined
      ? {}
      : { beforeContentBase64: value.beforeContentBase64 }),
    ...(value.afterContentBase64 === undefined
      ? {}
      : { afterContentBase64: value.afterContentBase64 }),
  };
}

export function serializePatchArtifact(
  artifact: SnapshotPatchArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function parsePatchArtifact(content: string): SnapshotPatchArtifact {
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidSnapshotArtifactError("artifact must be an object");
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1) {
    throw new InvalidSnapshotArtifactError("unsupported artifact version");
  }
  if (typeof value.checkpointId !== "string") {
    throw new InvalidSnapshotArtifactError("checkpointId must be a string");
  }
  if (typeof value.patchId !== "string") {
    throw new InvalidSnapshotArtifactError("patchId must be a string");
  }
  if (typeof value.createdAt !== "number") {
    throw new InvalidSnapshotArtifactError("createdAt must be a number");
  }
  if (!Array.isArray(value.files)) {
    throw new InvalidSnapshotArtifactError("files must be an array");
  }
  return {
    version: 1,
    checkpointId: value.checkpointId,
    patchId: value.patchId,
    createdAt: value.createdAt,
    files: value.files.map(parseFilePatch),
  };
}

export function filesFromArtifact(
  artifact: SnapshotPatchArtifact,
): readonly FileDiff[] {
  return artifact.files.map((file) => ({
    path: file.path,
    status: file.status,
  }));
}

export function summaryFromFiles(
  files: readonly FileDiff[],
): SnapshotDiffSummary {
  return summarize(files);
}

export class ShadowDiffEngine implements DiffEngine {
  private readonly baselines = new Map<string, FileState>();

  async recordBaseline(checkpointId: string, workdir: string): Promise<void> {
    this.baselines.set(checkpointId, await readFileState(workdir));
  }

  async computeDiff(
    checkpoint: SnapshotCheckpoint,
  ): Promise<ComputedSnapshotPatch> {
    const baseline = this.baselines.get(checkpoint.checkpointId);
    if (baseline === undefined) {
      throw new SnapshotBaselineNotFoundError(checkpoint.checkpointId);
    }
    const current = await readFileState(checkpoint.workdir);
    const paths = Array.from(
      new Set([...baseline.keys(), ...current.keys()]),
    ).sort();
    const files: FileDiff[] = [];
    const filePatches: SnapshotFilePatch[] = [];

    for (const path of paths) {
      const before = baseline.get(path);
      const after = current.get(path);

      if (before === undefined && after !== undefined) {
        files.push({ path, status: "added" });
        filePatches.push(createFilePatch(path, "added", undefined, after));
      } else if (before !== undefined && after === undefined) {
        files.push({ path, status: "deleted" });
        filePatches.push(createFilePatch(path, "deleted", before, undefined));
      } else if (
        before !== undefined &&
        after !== undefined &&
        !before.equals(after)
      ) {
        files.push({ path, status: "modified" });
        filePatches.push(createFilePatch(path, "modified", before, after));
      }
    }

    return {
      files,
      filePatches,
      summary: summarize(files),
      fileCount: files.length,
    };
  }

  async applyReverse(
    workdir: string,
    artifact: SnapshotPatchArtifact,
  ): Promise<void> {
    for (const file of artifact.files) {
      const target = resolveRelativePath(workdir, file.path);
      if (file.status === "added") {
        await rm(target, { force: true });
        continue;
      }

      const content = contentFromBase64(file.beforeContentBase64);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
}
