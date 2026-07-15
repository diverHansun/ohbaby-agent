import os from "node:os";
import path from "node:path";

export const OHBABY_DIR_NAME = ".ohbaby";
export const OHBABY_HOME_ENV = "OHBABY_HOME";
export const OHBABY_DATA_APP_NAME = "ohbaby";
export const OHBABY_DATABASE_FILE_NAME = "ohbaby.db";

export const OHBABY_LEGACY_DIR_NAME = ".ohbaby-agent";
export const OHBABY_LEGACY_DATA_APP_NAME = "ohbaby-agent";
export const OHBABY_LEGACY_DATABASE_FILE_NAME = "ohbaby-agent.db";

export interface OhbabyPathOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

type PathApi = typeof path.posix;

function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function context(options: OhbabyPathOptions): {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly homeDirectory: string;
  readonly path: PathApi;
  readonly platform: NodeJS.Platform;
} {
  const platform = options.platform ?? os.platform();
  return {
    environment: options.environment ?? process.env,
    homeDirectory: options.homeDirectory ?? os.homedir(),
    path: pathApi(platform),
    platform,
  };
}

function nonEmptyOr(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? fallback
    : normalized;
}

function configuredOhbabyHome(
  options: OhbabyPathOptions,
  input: ReturnType<typeof context>,
): string | undefined {
  if (options.homeDirectory !== undefined) {
    return undefined;
  }
  const configured = input.environment[OHBABY_HOME_ENV]?.trim();
  if (!configured) {
    return undefined;
  }
  if (!input.path.isAbsolute(configured)) {
    throw new Error(`${OHBABY_HOME_ENV} must be an absolute directory path`);
  }
  return input.path.normalize(configured);
}

/** Resolve the complete user-visible configuration root. */
export function resolveOhbabyHome(options: OhbabyPathOptions = {}): string {
  const input = context(options);
  return (
    configuredOhbabyHome(options, input) ??
    input.path.join(input.homeDirectory, OHBABY_DIR_NAME)
  );
}

/** Resolve the legacy user-visible configuration root for migration only. */
export function resolveLegacyOhbabyHome(
  options: OhbabyPathOptions = {},
): string {
  const input = context(options);
  return input.path.join(input.homeDirectory, OHBABY_LEGACY_DIR_NAME);
}

export function resolveProjectOhbabyRoot(
  projectDirectory: string,
  platform: NodeJS.Platform = os.platform(),
): string {
  return pathApi(platform).join(projectDirectory, OHBABY_DIR_NAME);
}

export function resolveLegacyProjectOhbabyRoot(
  projectDirectory: string,
  platform: NodeJS.Platform = os.platform(),
): string {
  return pathApi(platform).join(projectDirectory, OHBABY_LEGACY_DIR_NAME);
}

function platformDataBase(
  input: ReturnType<typeof context>,
  legacy: boolean,
): string {
  if (input.platform === "win32") {
    if (legacy) {
      return nonEmptyOr(
        input.environment.APPDATA,
        input.path.join(input.homeDirectory, "AppData", "Roaming"),
      );
    }
    return nonEmptyOr(
      input.environment.LOCALAPPDATA,
      input.path.join(input.homeDirectory, "AppData", "Local"),
    );
  }
  const xdgDataHome = input.environment.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return xdgDataHome;
  }
  if (input.platform === "darwin") {
    return input.path.join(
      input.homeDirectory,
      "Library",
      "Application Support",
    );
  }
  return input.path.join(input.homeDirectory, ".local", "share");
}

export function resolveOhbabyDataRoot(options: OhbabyPathOptions = {}): string {
  const input = context(options);
  return input.path.join(platformDataBase(input, false), OHBABY_DATA_APP_NAME);
}

export function resolveLegacyOhbabyDataRoot(
  options: OhbabyPathOptions = {},
): string {
  const input = context(options);
  return input.path.join(
    platformDataBase(input, true),
    OHBABY_LEGACY_DATA_APP_NAME,
  );
}

export function resolveLegacyGlobalMemoryPath(
  options: OhbabyPathOptions = {},
): string {
  const input = context(options);
  const configBase =
    input.platform === "win32"
      ? nonEmptyOr(input.environment.APPDATA, input.homeDirectory)
      : nonEmptyOr(
          input.environment.XDG_CONFIG_HOME,
          input.path.join(input.homeDirectory, ".config"),
        );
  return input.path.join(configBase, OHBABY_LEGACY_DATA_APP_NAME, "OHBABY.md");
}
