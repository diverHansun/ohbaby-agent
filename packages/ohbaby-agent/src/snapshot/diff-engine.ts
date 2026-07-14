import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveOhbabyDataRoot } from "../paths/index.js";
import {
  GitCommandError,
  GitNotAvailableError,
  SnapshotBaselineNotFoundError,
  type ComputedSnapshotPatch,
  type FileDiff,
  type FileDiffStatus,
  type SnapshotCheckpoint,
  type SnapshotDiffSummary,
} from "./types.js";

const execFileAsync = promisify(execFile);
const CORE_CONFIG = [
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
] as const;
const CFG_CONFIG = ["-c", "core.autocrlf=false", ...CORE_CONFIG] as const;
const QUOTE_CONFIG = [...CFG_CONFIG, "-c", "core.quotepath=false"] as const;
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "ohbaby-agent",
  GIT_AUTHOR_EMAIL: "snapshot@ohbaby.local",
  GIT_COMMITTER_NAME: "ohbaby-agent",
  GIT_COMMITTER_EMAIL: "snapshot@ohbaby.local",
} as const;

export interface DiffEngine {
  recordBaseline(checkpointId: string, workdir: string): Promise<string>;
  computeDiff(checkpoint: SnapshotCheckpoint): Promise<ComputedSnapshotPatch>;
  diffWorkingTree(checkpoint: SnapshotCheckpoint): Promise<readonly FileDiff[]>;
  restoreTo(workdir: string, commit: string): Promise<void>;
  diffBetween(
    workdir: string,
    from: string,
    to: string,
  ): Promise<readonly FileDiff[]>;
  dropRef(checkpointId: string, workdir: string): Promise<void>;
  dropPostRef(checkpointId: string, workdir: string): Promise<void>;
  restoreRefs(
    checkpointId: string,
    workdir: string,
    refs: { readonly preTreeRef?: string; readonly postTreeRef?: string },
  ): Promise<void>;
  gc(workdir: string, prune?: string): Promise<void>;
}

export interface GitSnapshotEngineOptions {
  readonly snapshotRoot?: string;
  readonly gitCommand?: string;
}

interface GitState {
  readonly gitdir: string;
  readonly workdir: string;
}

interface GitExecError extends Error {
  readonly code?: number | string;
  readonly stderr?: string | Buffer;
}

function defaultSnapshotRoot(): string {
  if (process.env.OHBABY_STORAGE_ROOT) {
    return dirname(resolve(process.env.OHBABY_STORAGE_ROOT));
  }
  return resolveOhbabyDataRoot();
}

function workdirHash(workdir: string): string {
  return createHash("sha1").update(resolve(workdir)).digest("hex").slice(0, 16);
}

function preRef(checkpointId: string): string {
  return `refs/snapshots/${checkpointId}/pre`;
}

function postRef(checkpointId: string): string {
  return `refs/snapshots/${checkpointId}/post`;
}

function summarize(files: readonly FileDiff[]): SnapshotDiffSummary {
  return {
    added: files.filter((file) => file.status === "added").length,
    modified: files.filter((file) => file.status === "modified").length,
    deleted: files.filter((file) => file.status === "deleted").length,
  };
}

function statusFromCode(code: string): FileDiffStatus {
  if (code.startsWith("A")) {
    return "added";
  }
  if (code.startsWith("D")) {
    return "deleted";
  }
  return "modified";
}

function parseNameStatus(output: string): readonly FileDiff[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [code, path] = line.split("\t");
      return {
        path,
        status: statusFromCode(code),
      };
    })
    .filter((file): file is FileDiff => typeof file.path === "string")
    .sort((left, right) => left.path.localeCompare(right.path));
}

function requirePreTreeRef(checkpoint: SnapshotCheckpoint): string {
  if (!checkpoint.preTreeRef) {
    throw new SnapshotBaselineNotFoundError(checkpoint.checkpointId);
  }
  return checkpoint.preTreeRef;
}

export function summaryFromFiles(
  files: readonly FileDiff[],
): SnapshotDiffSummary {
  return summarize(files);
}

export class GitSnapshotEngine implements DiffEngine {
  private readonly snapshotRoot: string;
  private readonly gitCommand: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: GitSnapshotEngineOptions = {}) {
    this.snapshotRoot = resolve(options.snapshotRoot ?? defaultSnapshotRoot());
    this.gitCommand = options.gitCommand ?? "git";
  }

  async recordBaseline(checkpointId: string, workdir: string): Promise<string> {
    const state = this.stateFor(workdir);
    return this.locked(state, async () => {
      const commit = await this.captureCommit(state, checkpointId);
      await this.updateRef(state, preRef(checkpointId), commit);
      return commit;
    });
  }

  async computeDiff(
    checkpoint: SnapshotCheckpoint,
  ): Promise<ComputedSnapshotPatch> {
    const pre = requirePreTreeRef(checkpoint);
    const state = this.stateFor(checkpoint.workdir);
    return this.locked(state, async () => {
      const commit = await this.captureCommit(state, checkpoint.checkpointId);
      const files = await this.diffCommits(state, pre, commit);
      await this.updateRef(state, postRef(checkpoint.checkpointId), commit);
      return {
        files,
        summary: summarize(files),
        fileCount: files.length,
        commit,
      };
    });
  }

  async diffWorkingTree(
    checkpoint: SnapshotCheckpoint,
  ): Promise<readonly FileDiff[]> {
    const pre = requirePreTreeRef(checkpoint);
    const state = this.stateFor(checkpoint.workdir);
    return this.locked(state, async () => {
      await this.ensureInitialized(state);
      await this.addAll(state);
      const output = await this.git(
        state,
        [
          ...QUOTE_CONFIG,
          ...this.worktreeArgs(state, [
            "diff",
            "--no-ext-diff",
            "--name-status",
            "--no-renames",
            "--cached",
            pre,
            "--",
            ".",
          ]),
        ],
        { cwd: state.workdir },
      );
      return parseNameStatus(output);
    });
  }

  async restoreTo(workdir: string, commit: string): Promise<void> {
    const state = this.stateFor(workdir);
    await this.locked(state, async () => {
      await this.ensureInitialized(state);
      await this.addAll(state);
      await this.git(
        state,
        [
          ...CORE_CONFIG,
          ...this.worktreeArgs(state, ["read-tree", "-u", "--reset", commit]),
        ],
        { cwd: state.workdir },
      );
    });
  }

  async diffBetween(
    workdir: string,
    from: string,
    to: string,
  ): Promise<readonly FileDiff[]> {
    const state = this.stateFor(workdir);
    return this.locked(state, async () => {
      await this.ensureInitialized(state);
      return this.diffCommits(state, from, to);
    });
  }

  async dropRef(checkpointId: string, workdir: string): Promise<void> {
    const state = this.stateFor(workdir);
    await this.locked(state, async () => {
      if (!(await this.isInitialized(state))) {
        return;
      }
      await this.deleteRef(state, preRef(checkpointId));
      await this.deleteRef(state, postRef(checkpointId));
    });
  }

  async dropPostRef(checkpointId: string, workdir: string): Promise<void> {
    const state = this.stateFor(workdir);
    await this.locked(state, async () => {
      if (!(await this.isInitialized(state))) {
        return;
      }
      await this.deleteRef(state, postRef(checkpointId));
    });
  }

  async restoreRefs(
    checkpointId: string,
    workdir: string,
    refs: { readonly preTreeRef?: string; readonly postTreeRef?: string },
  ): Promise<void> {
    const state = this.stateFor(workdir);
    await this.locked(state, async () => {
      await this.ensureInitialized(state);
      if (refs.preTreeRef) {
        await this.updateRef(state, preRef(checkpointId), refs.preTreeRef);
      }
      if (refs.postTreeRef) {
        await this.updateRef(state, postRef(checkpointId), refs.postTreeRef);
      }
    });
  }

  async gc(workdir: string, prune = "7.days"): Promise<void> {
    const state = this.stateFor(workdir);
    await this.locked(state, async () => {
      if (!(await this.isInitialized(state))) {
        return;
      }
      if (prune === "now") {
        await this.git(
          state,
          [
            ...this.worktreeArgs(state, [
              "reflog",
              "expire",
              "--expire=now",
              "--expire-unreachable=now",
              "--all",
            ]),
          ],
          { cwd: state.workdir },
        );
      }
      await this.git(
        state,
        [...this.worktreeArgs(state, ["gc", `--prune=${prune}`])],
        { cwd: state.workdir },
      );
    });
  }

  private stateFor(workdir: string): GitState {
    const resolvedWorkdir = resolve(workdir);
    return {
      gitdir: join(this.snapshotRoot, "snapshot-git", workdirHash(workdir)),
      workdir: resolvedWorkdir,
    };
  }

  private async locked<T>(state: GitState, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(state.gitdir) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(fn);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(state.gitdir, tail);
    try {
      return await operation;
    } finally {
      if (this.locks.get(state.gitdir) === tail) {
        this.locks.delete(state.gitdir);
      }
    }
  }

  private async captureCommit(
    state: GitState,
    checkpointId: string,
  ): Promise<string> {
    await this.ensureInitialized(state);
    await this.addAll(state);
    const tree = (
      await this.git(state, [...this.worktreeArgs(state, ["write-tree"])], {
        cwd: state.workdir,
      })
    ).trim();
    const commit = (
      await this.git(
        state,
        [
          ...this.worktreeArgs(state, [
            "commit-tree",
            tree,
            "-m",
            `snapshot ${checkpointId}`,
          ]),
        ],
        { cwd: state.workdir, env: COMMIT_ENV },
      )
    ).trim();
    return commit;
  }

  private async diffCommits(
    state: GitState,
    from: string,
    to: string,
  ): Promise<readonly FileDiff[]> {
    const output = await this.git(
      state,
      [
        ...QUOTE_CONFIG,
        ...this.worktreeArgs(state, [
          "diff",
          "--no-ext-diff",
          "--name-status",
          "--no-renames",
          from,
          to,
          "--",
          ".",
        ]),
      ],
      { cwd: state.workdir },
    );
    return parseNameStatus(output);
  }

  private async ensureInitialized(state: GitState): Promise<void> {
    if (await this.isInitialized(state)) {
      return;
    }
    await mkdir(state.gitdir, { recursive: true });
    await this.gitRaw(["init"], {
      env: {
        GIT_DIR: state.gitdir,
        GIT_WORK_TREE: state.workdir,
      },
    });
    await this.gitRaw([
      "--git-dir",
      state.gitdir,
      "config",
      "core.autocrlf",
      "false",
    ]);
    await this.gitRaw([
      "--git-dir",
      state.gitdir,
      "config",
      "core.longpaths",
      "true",
    ]);
    await this.gitRaw([
      "--git-dir",
      state.gitdir,
      "config",
      "core.symlinks",
      "true",
    ]);
    await this.gitRaw([
      "--git-dir",
      state.gitdir,
      "config",
      "core.fsmonitor",
      "false",
    ]);
  }

  private async isInitialized(state: GitState): Promise<boolean> {
    try {
      await access(join(state.gitdir, "config"));
      return true;
    } catch {
      return false;
    }
  }

  private async addAll(state: GitState): Promise<void> {
    await this.git(
      state,
      [...CFG_CONFIG, ...this.worktreeArgs(state, ["add", "--all", "."])],
      { cwd: state.workdir },
    );
  }

  private async deleteRef(state: GitState, ref: string): Promise<void> {
    await this.git(
      state,
      [...this.worktreeArgs(state, ["update-ref", "-d", ref])],
      { cwd: state.workdir },
    );
  }

  private async updateRef(
    state: GitState,
    ref: string,
    commit: string,
  ): Promise<void> {
    await this.git(
      state,
      [...this.worktreeArgs(state, ["update-ref", ref, commit])],
      { cwd: state.workdir },
    );
  }

  private worktreeArgs(state: GitState, args: readonly string[]): string[] {
    return ["--git-dir", state.gitdir, "--work-tree", state.workdir, ...args];
  }

  private git(
    state: GitState,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    } = {},
  ): Promise<string> {
    return this.gitRaw(args, {
      cwd: options.cwd ?? state.workdir,
      env: options.env,
    });
  }

  private async gitRaw(
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    } = {},
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.gitCommand, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const gitError = error as GitExecError;
      if (gitError.code === "ENOENT") {
        throw new GitNotAvailableError(this.gitCommand);
      }
      const exitCode = typeof gitError.code === "number" ? gitError.code : null;
      const stderr =
        gitError.stderr === undefined ? "" : String(gitError.stderr);
      throw new GitCommandError(args, exitCode, stderr.trim());
    }
  }
}
