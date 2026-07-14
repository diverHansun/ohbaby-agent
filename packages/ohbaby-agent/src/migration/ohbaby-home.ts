import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  cp,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { McpServerConfigSchema } from "../config/mcp/types.js";
import { parseEnvFile, setEnvFileValue } from "../config/llm/env-file.js";
import { writeFileAtomically } from "../config/secrets/atomic-file.js";
import {
  OHBABY_DATABASE_FILE_NAME,
  OHBABY_LEGACY_DATABASE_FILE_NAME,
  resolveLegacyGlobalMemoryPath,
  resolveLegacyOhbabyDataRoot,
  resolveLegacyOhbabyHome,
  resolveLegacyProjectOhbabyRoot,
  resolveOhbabyDataRoot,
  resolveOhbabyHome,
  resolveProjectOhbabyRoot,
  type OhbabyPathOptions,
} from "../paths/index.js";
import { Project } from "../project/index.js";

const CONFIG_MARKER_FILE = ".migrated-from-ohbaby-agent.json";
const DATA_MARKER_FILE = ".migrated-from-ohbaby-agent-data.json";
const SKIP_MARKER_FILE = ".skip-auto-migrate";
const LOCK_RETRY_MS = 25;
const LOCK_RETRY_LIMIT = 200;
const IGNORED_CONFIG_ENTRY_NAMES = new Set([".DS_Store"]);

export interface OhbabyMigrationOptions extends OhbabyPathOptions {
  readonly projectDirectory?: string;
  readonly onWarning?: (message: string) => void;
}

export interface OhbabyMigrationReport {
  readonly conflicts: readonly string[];
  readonly copied: readonly string[];
  readonly merged: readonly string[];
  readonly skipped: readonly string[];
}

interface MutableMigrationReport {
  readonly conflicts: string[];
  readonly copied: string[];
  readonly merged: string[];
  readonly skipped: string[];
}

function emptyReport(): MutableMigrationReport {
  return { conflicts: [], copied: [], merged: [], skipped: [] };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function warn(options: OhbabyMigrationOptions, message: string): void {
  if (options.onWarning) {
    options.onWarning(message);
    return;
  }
  process.emitWarning(message, { code: "OHBABY_MIGRATION" });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
      readonly pid?: unknown;
    };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

async function acquireMigrationLock(lockPath: string): Promise<FileHandle> {
  await mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
        "utf8",
      );
      return handle;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      const ownerPid = await readLockPid(lockPath);
      if (ownerPid === undefined || !processIsAlive(ownerPid)) {
        await unlink(lockPath).catch((unlinkError: unknown) => {
          if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
            throw unlinkError;
          }
        });
        continue;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_RETRY_MS);
      });
    }
  }
  throw new Error(`Timed out waiting for ohbaby migration lock: ${lockPath}`);
}

async function withMigrationLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const handle = await acquireMigrationLock(lockPath);
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function filesEqual(
  leftPath: string,
  rightPath: string,
): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([
    stat(leftPath),
    stat(rightPath),
  ]);
  if (leftStat.size !== rightStat.size) {
    return false;
  }
  const [left, right] = await Promise.all([
    open(leftPath, "r"),
    open(rightPath, "r"),
  ]);
  const leftBuffer = Buffer.allocUnsafe(64 * 1024);
  const rightBuffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    for (;;) {
      const [leftRead, rightRead] = await Promise.all([
        left.read(leftBuffer, 0, leftBuffer.length, position),
        right.read(rightBuffer, 0, rightBuffer.length, position),
      ]);
      if (leftRead.bytesRead !== rightRead.bytesRead) {
        return false;
      }
      if (leftRead.bytesRead === 0) {
        return true;
      }
      if (
        !leftBuffer
          .subarray(0, leftRead.bytesRead)
          .equals(rightBuffer.subarray(0, rightRead.bytesRead))
      ) {
        return false;
      }
      position += leftRead.bytesRead;
    }
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}

async function copyFileAtomically(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { mode: 0o700, recursive: true });
  const tempPath = `${targetPath}.migrating-${String(process.pid)}-${String(
    Date.now(),
  )}`;
  try {
    await copyFile(sourcePath, tempPath, fsConstants.COPYFILE_EXCL);
    await rename(tempPath, targetPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function siblingPath(targetPath: string): string {
  const parsed = path.parse(targetPath);
  return path.join(
    parsed.dir,
    `${parsed.name}.migrated-from-ohbaby-agent${parsed.ext}`,
  );
}

async function preserveConflict(
  sourcePath: string,
  targetPath: string,
  report: MutableMigrationReport,
  options: OhbabyMigrationOptions,
): Promise<void> {
  const sibling = siblingPath(targetPath);
  if (!(await exists(sibling))) {
    await copyFileAtomically(sourcePath, sibling);
    report.copied.push(sibling);
  }
  report.conflicts.push(targetPath);
  warn(
    options,
    `Legacy configuration conflicts with ${targetPath}; preserved at ${sibling}`,
  );
}

async function migrateRegularFile(
  sourcePath: string,
  targetPath: string,
  report: MutableMigrationReport,
  options: OhbabyMigrationOptions,
): Promise<void> {
  if (!(await exists(targetPath))) {
    await copyFileAtomically(sourcePath, targetPath);
    report.copied.push(targetPath);
    return;
  }
  if (await filesEqual(sourcePath, targetPath)) {
    report.skipped.push(targetPath);
    return;
  }
  await preserveConflict(sourcePath, targetPath, report, options);
}

async function migrateEnvFile(
  sourcePath: string,
  targetPath: string,
  report: MutableMigrationReport,
): Promise<void> {
  if (!(await exists(sourcePath))) {
    return;
  }
  if (!(await exists(targetPath))) {
    await copyFileAtomically(sourcePath, targetPath);
    report.copied.push(targetPath);
    return;
  }
  const [sourceContent, targetContent] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(targetPath, "utf8"),
  ]);
  const sourceValues = parseEnvFile(sourceContent);
  const targetValues = parseEnvFile(targetContent);
  let mergedContent = targetContent;
  const addedKeys: string[] = [];
  for (const [key, value] of Object.entries(sourceValues)) {
    if (Object.hasOwn(targetValues, key)) {
      continue;
    }
    mergedContent = setEnvFileValue(mergedContent, key, value);
    addedKeys.push(key);
  }
  if (addedKeys.length === 0) {
    report.skipped.push(targetPath);
    return;
  }
  await writeFileAtomically(targetPath, mergedContent);
  report.merged.push(`${targetPath} (${addedKeys.join(", ")})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(content: string): unknown {
  return JSON.parse(content) as unknown;
}

async function migrateMcpFile(
  sourcePath: string,
  targetPath: string,
  report: MutableMigrationReport,
  options: OhbabyMigrationOptions,
): Promise<void> {
  if (!(await exists(sourcePath))) {
    return;
  }
  if (!(await exists(targetPath))) {
    await copyFileAtomically(sourcePath, targetPath);
    report.copied.push(targetPath);
    return;
  }
  let sourceParsed: unknown;
  let targetParsed: unknown;
  try {
    [sourceParsed, targetParsed] = await Promise.all([
      readFile(sourcePath, "utf8").then(parseJson),
      readFile(targetPath, "utf8").then(parseJson),
    ]);
  } catch {
    await preserveConflict(sourcePath, targetPath, report, options);
    return;
  }
  const sourceServers =
    isRecord(sourceParsed) && isRecord(sourceParsed.mcpServers)
      ? sourceParsed.mcpServers
      : {};
  const targetServers =
    isRecord(targetParsed) && isRecord(targetParsed.mcpServers)
      ? targetParsed.mcpServers
      : {};
  const mergedServers: Record<string, unknown> = { ...targetServers };
  const added: string[] = [];
  for (const [name, server] of Object.entries(sourceServers)) {
    if (mergedServers[name] !== undefined) {
      continue;
    }
    if (!McpServerConfigSchema.safeParse(server).success) {
      report.conflicts.push(`${sourcePath}#${name}`);
      warn(
        options,
        `Legacy MCP server ${name} is invalid and was not migrated`,
      );
      continue;
    }
    mergedServers[name] = server;
    added.push(name);
  }
  if (added.length === 0) {
    report.skipped.push(targetPath);
    return;
  }
  await writeFileAtomically(
    targetPath,
    `${JSON.stringify({ mcpServers: mergedServers }, null, 2)}\n`,
  );
  report.merged.push(`${targetPath} (${added.join(", ")})`);
}

async function migrateConfigTree(
  sourceRoot: string,
  sourceBase: string,
  targetBase: string,
  report: MutableMigrationReport,
  options: OhbabyMigrationOptions,
): Promise<void> {
  if (!(await exists(sourceRoot))) {
    return;
  }
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    if (IGNORED_CONFIG_ENTRY_NAMES.has(entry.name)) {
      report.skipped.push(sourcePath);
      continue;
    }
    const relativePath = path.relative(sourceBase, sourcePath);
    const targetRelativePath =
      relativePath === "skill"
        ? "skills"
        : relativePath.startsWith(`skill${path.sep}`)
          ? path.join("skills", relativePath.slice("skill".length + 1))
          : relativePath;
    const targetPath = path.join(targetBase, targetRelativePath);
    if (entry.isSymbolicLink()) {
      report.skipped.push(sourcePath);
      warn(options, `Skipped legacy configuration symlink: ${sourcePath}`);
      continue;
    }
    if (entry.isDirectory()) {
      await migrateConfigTree(
        sourcePath,
        sourceBase,
        targetBase,
        report,
        options,
      );
      continue;
    }
    if (!entry.isFile()) {
      report.skipped.push(sourcePath);
      continue;
    }
    if (relativePath === ".env") {
      await migrateEnvFile(sourcePath, targetPath, report);
      continue;
    }
    if (relativePath === path.join("mcp", "settings.json")) {
      await migrateMcpFile(sourcePath, targetPath, report, options);
      continue;
    }
    await migrateRegularFile(sourcePath, targetPath, report, options);
  }
}

async function writeMarker(
  markerPath: string,
  report: MutableMigrationReport,
): Promise<void> {
  await writeFileAtomically(
    markerPath,
    `${JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        conflicts: report.conflicts,
        copied: report.copied,
        merged: report.merged,
      },
      null,
      2,
    )}\n`,
  );
}

function reportChanged(report: MutableMigrationReport): boolean {
  return (
    report.conflicts.length > 0 ||
    report.copied.length > 0 ||
    report.merged.length > 0
  );
}

async function migrateOneConfigRoot(
  sourceRoot: string,
  targetRoot: string,
  report: MutableMigrationReport,
  options: OhbabyMigrationOptions,
): Promise<void> {
  if (!(await exists(sourceRoot))) {
    return;
  }
  if (
    (await exists(path.join(sourceRoot, SKIP_MARKER_FILE))) ||
    (await exists(path.join(targetRoot, SKIP_MARKER_FILE)))
  ) {
    report.skipped.push(sourceRoot);
    return;
  }
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) {
    report.skipped.push(sourceRoot);
    return;
  }
  await mkdir(targetRoot, { mode: 0o700, recursive: true });
  if ((options.platform ?? process.platform) !== "win32") {
    await chmod(targetRoot, 0o700);
  }
  await withMigrationLock(
    path.join(targetRoot, ".ohbaby-agent-migration.lock"),
    () =>
      migrateConfigTree(sourceRoot, sourceRoot, targetRoot, report, options),
  );
}

export async function migrateOhbabyConfig(
  options: OhbabyMigrationOptions = {},
): Promise<OhbabyMigrationReport> {
  const report = emptyReport();
  const legacyHome = resolveLegacyOhbabyHome(options);
  const targetHome = resolveOhbabyHome(options);
  await migrateOneConfigRoot(legacyHome, targetHome, report, options);

  const legacyMemoryPath = resolveLegacyGlobalMemoryPath(options);
  if (
    legacyMemoryPath !== path.join(legacyHome, "OHBABY.md") &&
    (await exists(legacyMemoryPath))
  ) {
    await migrateRegularFile(
      legacyMemoryPath,
      path.join(targetHome, "OHBABY.md"),
      report,
      options,
    );
  }

  if (options.projectDirectory) {
    await migrateOneConfigRoot(
      resolveLegacyProjectOhbabyRoot(
        options.projectDirectory,
        options.platform,
      ),
      resolveProjectOhbabyRoot(options.projectDirectory, options.platform),
      report,
      options,
    );
  }

  if (reportChanged(report)) {
    await writeMarker(path.join(targetHome, CONFIG_MARKER_FILE), report);
  }
  return report;
}

async function readDaemonPid(
  options: OhbabyMigrationOptions,
): Promise<number | undefined> {
  const pidPath = path.join(resolveOhbabyHome(options), "server", "daemon.pid");
  return readLockPid(pidPath);
}

async function readLegacyDaemonPid(
  options: OhbabyMigrationOptions,
): Promise<number | undefined> {
  const startDirectory = options.projectDirectory ?? process.cwd();
  const projectRoot =
    (await Project.getProjectRoot(startDirectory)) ??
    path.resolve(startDirectory);
  return readLockPid(
    path.join(projectRoot, ".ohbaby", "server", "daemon-state.json"),
  );
}

async function assertNoLiveDaemon(
  options: OhbabyMigrationOptions,
): Promise<void> {
  const pid = await readDaemonPid(options);
  if (pid !== undefined && processIsAlive(pid)) {
    throw new Error(
      `Cannot migrate legacy ohbaby data while daemon process ${String(pid)} is running. Stop it with "ohbaby serve stop" and retry.`,
    );
  }
  const legacyPid = await readLegacyDaemonPid(options);
  if (legacyPid !== undefined && processIsAlive(legacyPid)) {
    throw new Error(
      `Cannot migrate legacy ohbaby data while legacy project daemon process ${String(legacyPid)} is running. Stop it from that project with "ohbaby serve stop" and retry.`,
    );
  }
}

async function renameDatabaseFilesInRoot(root: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", ""] as const) {
    const legacyPath = path.join(
      root,
      `${OHBABY_LEGACY_DATABASE_FILE_NAME}${suffix}`,
    );
    if (!(await exists(legacyPath))) {
      continue;
    }
    await rename(
      legacyPath,
      path.join(root, `${OHBABY_DATABASE_FILE_NAME}${suffix}`),
    );
  }
}

async function copyDatabaseGroup(
  sourceRoot: string,
  targetRoot: string,
  report: MutableMigrationReport,
): Promise<void> {
  const sourceDatabase = path.join(
    sourceRoot,
    OHBABY_LEGACY_DATABASE_FILE_NAME,
  );
  const targetDatabase = path.join(targetRoot, OHBABY_DATABASE_FILE_NAME);
  if (!(await exists(sourceDatabase))) {
    return;
  }
  if (await exists(targetDatabase)) {
    if (!(await filesEqual(sourceDatabase, targetDatabase))) {
      throw new Error(
        `Legacy and new ohbaby databases both exist and differ: ${sourceDatabase} and ${targetDatabase}. Refusing to choose one automatically.`,
      );
    }
  }
  await mkdir(targetRoot, { mode: 0o700, recursive: true });
  for (const suffix of ["-wal", "-shm", ""] as const) {
    const sourcePath = path.join(
      sourceRoot,
      `${OHBABY_LEGACY_DATABASE_FILE_NAME}${suffix}`,
    );
    if (!(await exists(sourcePath))) {
      continue;
    }
    const targetPath = path.join(
      targetRoot,
      `${OHBABY_DATABASE_FILE_NAME}${suffix}`,
    );
    if (await exists(targetPath)) {
      if (!(await filesEqual(sourcePath, targetPath))) {
        throw new Error(
          `Legacy and new ohbaby database sidecars both exist and differ: ${sourcePath} and ${targetPath}. Refusing to choose one automatically.`,
        );
      }
      report.skipped.push(targetPath);
      continue;
    }
    await copyFileAtomically(sourcePath, targetPath);
    report.copied.push(targetPath);
  }
}

async function copyDataTreeMissing(
  sourceRoot: string,
  targetRoot: string,
  report: MutableMigrationReport,
): Promise<void> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === OHBABY_LEGACY_DATABASE_FILE_NAME ||
      entry.name === `${OHBABY_LEGACY_DATABASE_FILE_NAME}-wal` ||
      entry.name === `${OHBABY_LEGACY_DATABASE_FILE_NAME}-shm`
    ) {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { mode: 0o700, recursive: true });
      await copyDataTreeMissing(sourcePath, targetPath, report);
      continue;
    }
    if (!entry.isFile()) {
      report.skipped.push(sourcePath);
      continue;
    }
    if (await exists(targetPath)) {
      report.skipped.push(targetPath);
      continue;
    }
    await copyFileAtomically(sourcePath, targetPath);
    report.copied.push(targetPath);
  }
}

export async function migrateOhbabyData(
  options: OhbabyMigrationOptions = {},
): Promise<OhbabyMigrationReport> {
  const report = emptyReport();
  const sourceRoot = resolveLegacyOhbabyDataRoot(options);
  if (!(await exists(sourceRoot))) {
    return report;
  }
  const targetRoot = resolveOhbabyDataRoot(options);
  if (
    (await exists(path.join(sourceRoot, SKIP_MARKER_FILE))) ||
    (await exists(path.join(targetRoot, SKIP_MARKER_FILE)))
  ) {
    report.skipped.push(sourceRoot);
    return report;
  }
  const markerPath = path.join(targetRoot, DATA_MARKER_FILE);
  if (await exists(markerPath)) {
    report.skipped.push(sourceRoot);
    return report;
  }
  await assertNoLiveDaemon(options);
  const lockPath = path.join(
    path.dirname(targetRoot),
    ".ohbaby-data-migration.lock",
  );
  return withMigrationLock(lockPath, async () => {
    if (await exists(markerPath)) {
      report.skipped.push(sourceRoot);
      return report;
    }
    if (!(await exists(targetRoot))) {
      const tempRoot = `${targetRoot}.migrating-${String(process.pid)}`;
      await rm(tempRoot, { force: true, recursive: true });
      try {
        await cp(sourceRoot, tempRoot, {
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          recursive: true,
        });
        await renameDatabaseFilesInRoot(tempRoot);
        await rename(tempRoot, targetRoot);
        report.copied.push(targetRoot);
      } finally {
        await rm(tempRoot, { force: true, recursive: true }).catch(
          () => undefined,
        );
      }
    } else {
      await copyDatabaseGroup(sourceRoot, targetRoot, report);
      await copyDataTreeMissing(sourceRoot, targetRoot, report);
    }
    await writeMarker(markerPath, report);
    return report;
  });
}
