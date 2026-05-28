import fs from "node:fs/promises";
import path from "node:path";
import {
  analyzeShellCommand,
  type ShellCommandAnalysis,
} from "../shell/index.js";
import { classifySandboxPath } from "./boundary.js";
import { classifyDenylistedPath, classifySensitivePath } from "./denylist.js";
import { canonicalizeSandboxPath, resolveSandboxPathArg } from "./paths.js";
import type {
  PreflightCommand,
  PreflightDenylistHit,
  PreflightExternalPath,
  PreflightInternalPath,
  PreflightSensitivePath,
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

interface CommandPathFact {
  readonly original: string;
  readonly isExecutedScript?: boolean;
}

async function externalAskPattern(absolutePath: string): Promise<string> {
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      return path.join(absolutePath, "**");
    }
  } catch {
    // Missing or unreadable paths fall back to their parent directory.
  }

  return path.join(path.dirname(absolutePath), "**");
}

function toPreflightCommand(command: ShellCommandAnalysis): PreflightCommand {
  return { ...command };
}

function commandPathFacts(
  command: ShellCommandAnalysis,
): readonly CommandPathFact[] {
  const facts: CommandPathFact[] = [];
  const seen = new Set<string>();
  if (command.executedScript) {
    facts.push({
      isExecutedScript: true,
      original: command.executedScript,
    });
    seen.add(command.executedScript);
  }
  for (const pathArg of command.pathArgs) {
    if (seen.has(pathArg)) {
      continue;
    }
    facts.push({ original: pathArg });
    seen.add(pathArg);
  }
  return facts;
}

export async function preflightSandboxShellAnalysis(
  input: SandboxShellAnalysisPreflightInput,
): Promise<PreflightResult> {
  const commands = input.shell.commands.map(toPreflightCommand);
  const internalPaths: PreflightInternalPath[] = [];
  const externalPaths: PreflightExternalPath[] = [];
  const denylistHits: PreflightDenylistHit[] = [];
  const sensitivePaths: PreflightSensitivePath[] = [];
  const canonicalWorkdir = await canonicalizeSandboxPath(input.workdir);
  const trustedRoots = [
    canonicalWorkdir,
    ...(await Promise.all(
      (input.trustedRoots ?? []).map((root) => canonicalizeSandboxPath(root)),
    )),
  ];
  let overallDanger: PreflightCommand["danger"] = "readonly";

  for (const command of commands) {
    overallDanger = maxDanger(overallDanger, command.danger);
    for (const fact of commandPathFacts(command)) {
      const resolvedPath = resolveSandboxPathArg({
        arg: fact.original,
        shellKind: input.shell.shellKind,
        workdir: input.workdir,
      });
      if (!resolvedPath) {
        continue;
      }
      const absolutePath = await canonicalizeSandboxPath(resolvedPath);

      const reason =
        classifyDenylistedPath(resolvedPath) ??
        classifyDenylistedPath(absolutePath);
      if (reason) {
        denylistHits.push({
          absolutePath,
          ...(fact.isExecutedScript ? { isExecutedScript: true } : {}),
          original: fact.original,
          reason,
        });
        continue;
      }

      const sensitiveReason =
        classifySensitivePath(resolvedPath) ??
        classifySensitivePath(absolutePath);
      if (sensitiveReason) {
        sensitivePaths.push({
          absolutePath,
          askPattern: absolutePath,
          ...(fact.isExecutedScript ? { isExecutedScript: true } : {}),
          original: fact.original,
          reason: sensitiveReason,
        });
      }

      if (classifySandboxPath({ absolutePath, trustedRoots }) === "outside") {
        externalPaths.push({
          absolutePath,
          askPattern: await externalAskPattern(absolutePath),
          ...(fact.isExecutedScript ? { isExecutedScript: true } : {}),
          original: fact.original,
        });
        continue;
      }

      internalPaths.push({
        absolutePath,
        ...(fact.isExecutedScript ? { isExecutedScript: true } : {}),
        original: fact.original,
      });
    }
  }

  return {
    commands,
    denylistHits,
    externalPaths,
    internalPaths,
    overallDanger,
    parseError: input.shell.parseError,
    sensitivePaths,
    shellKind: input.shell.shellKind,
  };
}

export async function preflightSandboxCommand(
  input: SandboxPreflightInput,
): Promise<PreflightResult> {
  const shell = await analyzeShellCommand(input.command, input.shellKind);
  return preflightSandboxShellAnalysis({
    shell,
    trustedRoots: input.trustedRoots,
    workdir: input.workdir,
  });
}
