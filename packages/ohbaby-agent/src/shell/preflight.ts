import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandDetail, ParsedCommand } from "../utils/index.js";
import { containsOrEqual, parseCommand } from "../utils/index.js";

export type ShellKind = "bash" | "cmd" | "powershell";

export interface ShellPreflightInput {
  readonly command: string;
  readonly cwd: string;
  readonly parsed: ParsedCommand;
  readonly rootCwd: string;
  readonly shellKind: ShellKind;
}

export interface ShellPreflightResult {
  readonly cdTargets: readonly string[];
  readonly resolvedPaths: readonly string[];
}

export class ShellPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellPreflightError";
  }
}

const DIRECTORY_COMMANDS = new Set([
  "cd",
  "chdir",
  "push-location",
  "pushd",
  "set-location",
  "sl",
]);
const DOWNLOAD_COMMANDS = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-restmethod",
  "invoke-webrequest",
]);
const SHELL_EXEC_COMMANDS = new Set([
  "bash",
  "cmd",
  "iex",
  "invoke-expression",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const PATH_ARGUMENT_COMMANDS = new Set([
  "cat",
  "chmod",
  "chown",
  "copy",
  "cp",
  "del",
  "dir",
  "erase",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "md",
  "mkdir",
  "more",
  "move",
  "mv",
  "add-content",
  "clear-content",
  "copy-item",
  "get-childitem",
  "get-content",
  "move-item",
  "new-item",
  "rd",
  "remove-item",
  "rm",
  "rmdir",
  "rg",
  "set-content",
  "tail",
  "tee",
  "touch",
  "type",
  "xcopy",
]);
const DYNAMIC_PATH_PATTERN = /[`$%*?[\]{}]/u;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
const DRIVE_RELATIVE_PATTERN = /^[A-Za-z]:[^\\/]/u;
const PROVIDER_PATH_PATTERN = /^[A-Za-z][\w-]*:/u;

function basenameLower(shellPath: string): string {
  return path.basename(shellPath).toLowerCase();
}

function normalizeRoot(root: string): string {
  return root.toLowerCase().replace(/\.exe$/u, "");
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function detectShellKind(shellPath: string): ShellKind {
  const shellName = basenameLower(shellPath);
  if (
    shellName === "cmd" ||
    shellName === "cmd.exe" ||
    shellName === "command.com"
  ) {
    return "cmd";
  }
  if (
    shellName === "powershell" ||
    shellName === "powershell.exe" ||
    shellName === "pwsh" ||
    shellName === "pwsh.exe"
  ) {
    return "powershell";
  }
  return "bash";
}

export function shellArgs(
  shellPath: string,
  command: string,
): readonly string[] {
  const shellKind = detectShellKind(shellPath);
  if (shellKind === "cmd") {
    return ["/d", "/s", "/c", command];
  }
  if (shellKind === "powershell") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  }

  return ["-lc", command];
}

function commandArgs(detail: CommandDetail): readonly string[] {
  return detail.tokens.slice(detail.rootIndex + 1);
}

function reject(message: string): never {
  throw new ShellPreflightError(message);
}

function isDangerousRootTarget(target: string): boolean {
  const normalized = target.trim().replace(/["']/gu, "");
  return (
    normalized === "/" ||
    normalized === "/*" ||
    normalized === "~" ||
    normalized === "~/" ||
    /^[A-Za-z]:[\\/]*$/u.test(normalized) ||
    normalized === "\\"
  );
}

function hasUnixRecursiveForce(args: readonly string[]): boolean {
  const flags = args.filter((arg) => arg.startsWith("-")).join("");
  return /r|R/u.test(flags) && flags.includes("f");
}

function hasCmdSwitch(args: readonly string[], switchName: string): boolean {
  return args.some((arg) => arg.toLowerCase() === switchName);
}

function hasPowerShellSwitch(
  args: readonly string[],
  switchName: string,
): boolean {
  const normalized = switchName.toLowerCase();
  return args.some((arg) => arg.toLowerCase() === normalized);
}

function assertNotBlacklisted(
  detail: CommandDetail,
  shellKind: ShellKind,
): void {
  const root = normalizeRoot(detail.root);
  const args = commandArgs(detail);
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (
    root === "rm" &&
    hasUnixRecursiveForce(args) &&
    args.some(isDangerousRootTarget)
  ) {
    reject("Command is blacklisted: recursive forced removal of a root path.");
  }

  if (
    shellKind === "cmd" &&
    (root === "rmdir" || root === "rd" || root === "del" || root === "erase") &&
    hasCmdSwitch(lowerArgs, "/s") &&
    hasCmdSwitch(lowerArgs, "/q") &&
    args.some(isDangerousRootTarget)
  ) {
    reject("Command is blacklisted: destructive removal of a root path.");
  }

  if (
    shellKind === "powershell" &&
    (root === "remove-item" ||
      root === "rm" ||
      root === "del" ||
      root === "erase") &&
    hasPowerShellSwitch(lowerArgs, "-recurse") &&
    hasPowerShellSwitch(lowerArgs, "-force") &&
    args.some(isDangerousRootTarget)
  ) {
    reject("Command is blacklisted: destructive removal of a root path.");
  }

  if (["format", "shutdown", "reboot", "halt", "poweroff"].includes(root)) {
    reject(`Command is blacklisted: ${detail.root}.`);
  }
}

function commandParts(command: string): readonly {
  readonly operatorBefore: string | undefined;
  readonly text: string;
}[] {
  const parts: { operatorBefore: string | undefined; text: string }[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let operatorBefore: string | undefined;
  const chars = Array.from(command);

  function pushPart(): void {
    const text = current.trim();
    if (text) {
      parts.push({ operatorBefore, text });
    }
    current = "";
  }

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (quote === null && (char === "|" || char === "&" || char === ";")) {
      const next = chars[index + 1];
      pushPart();
      if ((char === "|" || char === "&") && next === char) {
        operatorBefore = `${char}${next}`;
        index += 1;
      } else {
        operatorBefore = char;
      }
      continue;
    }
    if (quote === null && (char === "\n" || char === "\r")) {
      pushPart();
      operatorBefore = "\n";
      if (char === "\r" && chars[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  pushPart();

  return parts;
}

function firstRoot(command: string): string | undefined {
  const parsed = parseSingleSegment(command);
  return parsed ? normalizeRoot(parsed.root) : undefined;
}

function parseSingleSegment(
  command: string,
): Pick<CommandDetail, "root"> | undefined {
  return command.length > 0 ? parseCommand(command).details[0] : undefined;
}

function assertNoDownloadExecutePipeline(command: string): void {
  let pipeHasDownload = false;
  for (const part of commandParts(command)) {
    if (part.operatorBefore !== "|") {
      pipeHasDownload = false;
    }
    const root = firstRoot(part.text);
    if (!root) {
      continue;
    }
    if (DOWNLOAD_COMMANDS.has(root)) {
      pipeHasDownload = true;
      continue;
    }
    if (pipeHasDownload && SHELL_EXEC_COMMANDS.has(root)) {
      reject(
        "Command pipes downloaded content into a shell; use a reviewed file and explicit execution instead.",
      );
    }
  }
}

function compactCmdCdTarget(root: string, shellKind: ShellKind): string | null {
  if (shellKind !== "cmd") {
    return null;
  }
  const normalized = normalizeRoot(root);
  if (normalized === "cd.." || normalized === "chdir..") {
    return "..";
  }
  if (normalized === "cd." || normalized === "chdir.") {
    return ".";
  }
  if (normalized.startsWith("cd\\") || normalized.startsWith("cd/")) {
    return root.slice(2);
  }
  if (normalized.startsWith("chdir\\") || normalized.startsWith("chdir/")) {
    return root.slice(5);
  }

  return null;
}

function assertNoNestedShellEvaluation(detail: CommandDetail): void {
  const root = normalizeRoot(detail.root);
  if (!SHELL_EXEC_COMMANDS.has(root)) {
    return;
  }
  const args = commandArgs(detail).map((arg) => arg.toLowerCase());
  if (
    args.includes("-c") ||
    args.includes("/c") ||
    args.includes("-command") ||
    args.includes("-encodedcommand")
  ) {
    reject("Nested shell evaluation cannot be sandbox-checked safely.");
  }
}

function isDirectoryCommand(
  detail: CommandDetail,
  shellKind: ShellKind,
): boolean {
  return (
    DIRECTORY_COMMANDS.has(normalizeRoot(detail.root)) ||
    compactCmdCdTarget(detail.root, shellKind) !== null
  );
}

function stripCdOptions(
  args: readonly string[],
  shellKind: ShellKind,
  root: string,
): readonly string[] {
  const normalizedRoot = normalizeRoot(root);
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const lower = arg.toLowerCase();
    if (shellKind === "cmd" && lower === "/d") {
      continue;
    }
    if (
      shellKind === "bash" &&
      (arg === "-L" || arg === "-P" || arg === "--")
    ) {
      continue;
    }
    if (
      shellKind === "powershell" &&
      (lower === "-path" || lower === "-literalpath") &&
      index + 1 < args.length
    ) {
      output.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (
      shellKind === "powershell" &&
      normalizedRoot !== "cd" &&
      lower.startsWith("-")
    ) {
      continue;
    }
    output.push(arg);
  }

  return output;
}

function cdTarget(detail: CommandDetail, shellKind: ShellKind): string {
  const compactTarget = compactCmdCdTarget(detail.root, shellKind);
  if (compactTarget !== null) {
    return compactTarget;
  }
  const candidates = stripCdOptions(
    commandArgs(detail),
    shellKind,
    detail.root,
  );
  const target = candidates.find((arg) => arg.trim().length > 0);
  if (!target || target === "-") {
    reject(
      "Directory-changing commands require a static target inside the workspace.",
    );
  }
  return target;
}

function assertStaticPath(target: string): void {
  const stripped = stripMatchingQuotes(target);
  if (URL_PATTERN.test(stripped)) {
    return;
  }
  if (DRIVE_RELATIVE_PATTERN.test(stripped)) {
    reject(
      `Path "${target}" uses drive-relative syntax and cannot be sandbox-checked safely.`,
    );
  }
  if (
    PROVIDER_PATH_PATTERN.test(stripped) &&
    !DRIVE_ABSOLUTE_PATTERN.test(stripped)
  ) {
    reject(
      `Path "${target}" uses provider syntax and cannot be sandbox-checked safely.`,
    );
  }
  if (DYNAMIC_PATH_PATTERN.test(stripped)) {
    reject(`Path "${target}" is dynamic and cannot be sandbox-checked safely.`);
  }
}

function msysPathToWindowsPath(target: string): string | null {
  const match = /^\/([A-Za-z])(?:\/(.*))?$/u.exec(target);
  if (!match || process.platform !== "win32") {
    return null;
  }
  const drive = match[1].toUpperCase();
  const rest = match[2] ? match[2].replace(/\//gu, "\\") : "";
  return `${drive}:\\${rest}`;
}

function resolveLexicalPath(
  currentCwd: string,
  target: string,
  shellKind: ShellKind,
): string {
  const stripped = stripMatchingQuotes(target);
  if (stripped === "~") {
    return os.homedir();
  }
  if (stripped.startsWith("~/") || stripped.startsWith("~\\")) {
    return path.resolve(os.homedir(), stripped.slice(2));
  }
  const msysPath =
    shellKind === "bash" ? msysPathToWindowsPath(stripped) : null;
  if (msysPath) {
    return path.resolve(msysPath);
  }
  if (path.isAbsolute(stripped)) {
    return path.resolve(stripped);
  }
  return path.resolve(currentCwd, stripped);
}

async function resolveForSandboxCheck(
  currentCwd: string,
  target: string,
  shellKind: ShellKind,
): Promise<string> {
  assertStaticPath(target);
  const candidate = resolveLexicalPath(currentCwd, target, shellKind);
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const parent = await fs.realpath(path.dirname(candidate));
    return path.join(parent, path.basename(candidate));
  }
}

async function realpathOrResolve(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return path.resolve(value);
  }
}

async function assertPathInsideWorkspace(input: {
  readonly currentCwd: string;
  readonly rootCwd: string;
  readonly shellKind: ShellKind;
  readonly target: string;
}): Promise<string> {
  const resolved = await resolveForSandboxCheck(
    input.currentCwd,
    input.target,
    input.shellKind,
  );
  if (!containsOrEqual(input.rootCwd, resolved)) {
    reject(
      `Path "${input.target}" resolves outside the workspace: ${resolved}`,
    );
  }
  return resolved;
}

function stripRedirectionPrefix(token: string): string {
  return token.replace(/^(?:\d+|&)?[<>]+/u, "");
}

function optionValue(token: string): string | null {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex > 0) {
    return token.slice(equalsIndex + 1);
  }
  const colonIndex = token.indexOf(":");
  if (token.startsWith("/") && colonIndex > 1) {
    return token.slice(colonIndex + 1);
  }

  return null;
}

function looksLikePathToken(token: string): boolean {
  const normalized = stripMatchingQuotes(stripRedirectionPrefix(token));
  const value = optionValue(normalized) ?? normalized;
  if (!value || URL_PATTERN.test(value)) {
    return false;
  }
  if (value === "." || value === "..") {
    return true;
  }
  if (value.startsWith("~")) {
    return true;
  }
  if (
    DRIVE_ABSOLUTE_PATTERN.test(value) ||
    DRIVE_RELATIVE_PATTERN.test(value)
  ) {
    return true;
  }
  if (PROVIDER_PATH_PATTERN.test(value) && !URL_PATTERN.test(value)) {
    return true;
  }
  return false;
}

function candidatePathFromToken(token: string): string | null {
  const normalized = stripMatchingQuotes(stripRedirectionPrefix(token));
  const value = optionValue(normalized) ?? normalized;
  if (!value || URL_PATTERN.test(value)) {
    return null;
  }
  return value;
}

function rootAcceptsPathArguments(detail: CommandDetail): boolean {
  const root = normalizeRoot(detail.root);
  return (
    PATH_ARGUMENT_COMMANDS.has(root) ||
    DOWNLOAD_COMMANDS.has(root) ||
    SHELL_EXEC_COMMANDS.has(root)
  );
}

function pathTokens(detail: CommandDetail): readonly string[] {
  const rootIndex = detail.rootIndex;
  const candidates = new Set<string>();
  for (const candidate of detail.paths) {
    const tokenIndex = detail.tokens.indexOf(candidate);
    if (tokenIndex === -1 || tokenIndex > rootIndex) {
      candidates.add(candidate);
    }
  }
  for (const [tokenIndex, token] of detail.tokens.entries()) {
    if (tokenIndex <= rootIndex) {
      continue;
    }
    if (!rootAcceptsPathArguments(detail) && !looksLikePathToken(token)) {
      continue;
    }
    const candidate = candidatePathFromToken(token);
    if (!candidate) {
      continue;
    }
    if (rootAcceptsPathArguments(detail) || looksLikePathToken(token)) {
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

function downloadOutputTargets(detail: CommandDetail): readonly string[] {
  if (!DOWNLOAD_COMMANDS.has(normalizeRoot(detail.root))) {
    return [];
  }
  const args = commandArgs(detail);
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const lower = arg.toLowerCase();
    if (
      (lower === "-o" ||
        lower === "--output" ||
        lower === "-outfile" ||
        lower === "--output-document") &&
      args[index + 1]
    ) {
      targets.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (
      lower.startsWith("--output=") ||
      lower.startsWith("--output-document=")
    ) {
      const value = optionValue(arg);
      if (value) {
        targets.push(value);
      }
    }
  }

  return targets;
}

function shellInputTargets(detail: CommandDetail): readonly string[] {
  if (!SHELL_EXEC_COMMANDS.has(normalizeRoot(detail.root))) {
    return [];
  }
  return commandArgs(detail)
    .filter((arg) => !arg.startsWith("-") && !arg.startsWith("/"))
    .flatMap((arg) => {
      const candidate = candidatePathFromToken(arg);
      return candidate ? [candidate] : [];
    });
}

export async function preflightShellCommand(
  input: ShellPreflightInput,
): Promise<ShellPreflightResult> {
  const rootCwd = await realpathOrResolve(input.rootCwd);
  let currentCwd = await realpathOrResolve(input.cwd);
  const cdTargets: string[] = [];
  const resolvedPaths: string[] = [];
  const downloadedFiles = new Set<string>();

  assertNoDownloadExecutePipeline(input.command);

  for (const detail of input.parsed.details) {
    assertNotBlacklisted(detail, input.shellKind);
    assertNoNestedShellEvaluation(detail);

    if (isDirectoryCommand(detail, input.shellKind)) {
      const target = cdTarget(detail, input.shellKind);
      const resolved = await assertPathInsideWorkspace({
        currentCwd,
        rootCwd,
        shellKind: input.shellKind,
        target,
      });
      currentCwd = resolved;
      cdTargets.push(resolved);
      continue;
    }

    for (const target of downloadOutputTargets(detail)) {
      const resolved = await assertPathInsideWorkspace({
        currentCwd,
        rootCwd,
        shellKind: input.shellKind,
        target,
      });
      downloadedFiles.add(resolved);
      resolvedPaths.push(resolved);
    }

    for (const target of shellInputTargets(detail)) {
      const resolved = await assertPathInsideWorkspace({
        currentCwd,
        rootCwd,
        shellKind: input.shellKind,
        target,
      });
      if (downloadedFiles.has(resolved)) {
        reject(
          "Command downloads a file and executes it in the same shell request.",
        );
      }
      resolvedPaths.push(resolved);
    }

    for (const target of pathTokens(detail)) {
      const resolved = await assertPathInsideWorkspace({
        currentCwd,
        rootCwd,
        shellKind: input.shellKind,
        target,
      });
      resolvedPaths.push(resolved);
    }
  }

  return { cdTargets, resolvedPaths };
}
