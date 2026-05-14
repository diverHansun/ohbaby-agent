import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const GIT_COMMAND_MAX_BUFFER = 1024 * 1024;

export async function getGitProjectId(
  worktree: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--max-parents=0", "--all"],
      {
        cwd: worktree,
        encoding: "utf8",
        maxBuffer: GIT_COMMAND_MAX_BUFFER,
        timeout: GIT_COMMAND_TIMEOUT_MS,
      },
    );
    const commits = stdout
      .split(/\r?\n/u)
      .map((commit) => commit.trim())
      .filter(Boolean)
      .sort();

    return commits[0] ?? null;
  } catch {
    return null;
  }
}
