import path from "node:path";
import {
  analyzeShellCommand,
  type ShellCommandAnalysis,
} from "../shell/index.js";
import { classifySandboxPath } from "./boundary.js";
import { classifyDenylistedPath } from "./denylist.js";
import { resolveSandboxPathArg } from "./paths.js";
import type {
  PreflightCommand,
  PreflightDenylistHit,
  PreflightExternalPath,
  PreflightInternalPath,
  PreflightResult,
  SandboxPreflightInput,
  SandboxShellAnalysisPreflightInput,
} from "./types.js";

const DANGER_RANK: Record<PreflightCommand["danger"], number> = {
  readonly: 0,
  mutating: 1,
  dangerous: 2,
};

function maxDanger(
  current: PreflightCommand["danger"],
  next: PreflightCommand["danger"],
): PreflightCommand["danger"] {
  return DANGER_RANK[next] > DANGER_RANK[current] ? next : current;
}

function externalAskPattern(absolutePath: string): string {
  return path.join(path.dirname(absolutePath), "**");
}

function toPreflightCommand(
  command: ShellCommandAnalysis,
): PreflightCommand {
  return { ...command };
}

export function preflightSandboxShellAnalysis(
  input: SandboxShellAnalysisPreflightInput,
): PreflightResult {
  const commands = input.shell.commands.map(toPreflightCommand);
  const internalPaths: PreflightInternalPath[] = [];
  const externalPaths: PreflightExternalPath[] = [];
  const denylistHits: PreflightDenylistHit[] = [];
  let overallDanger: PreflightCommand["danger"] = "readonly";

  for (const command of commands) {
    overallDanger = maxDanger(overallDanger, command.danger);
    for (const original of command.pathArgs) {
      const absolutePath = resolveSandboxPathArg({
        arg: original,
        shellKind: input.shell.shellKind,
        workdir: input.workdir,
      });
      if (!absolutePath) {
        continue;
      }

      const reason = classifyDenylistedPath(absolutePath);
      if (reason) {
        denylistHits.push({ absolutePath, original, reason });
        continue;
      }

      if (
        classifySandboxPath({ absolutePath, workdir: input.workdir }) ===
        "outside"
      ) {
        externalPaths.push({
          absolutePath,
          askPattern: externalAskPattern(absolutePath),
          original,
        });
        continue;
      }

      internalPaths.push({ absolutePath, original });
    }
  }

  return {
    commands,
    denylistHits,
    externalPaths,
    internalPaths,
    overallDanger,
    parseError: input.shell.parseError,
    shellKind: input.shell.shellKind,
  };
}

export async function preflightSandboxCommand(
  input: SandboxPreflightInput,
): Promise<PreflightResult> {
  const shell = await analyzeShellCommand(input.command, input.shellKind);
  return preflightSandboxShellAnalysis({
    shell,
    workdir: input.workdir,
  });
}
