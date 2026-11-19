import { readFileSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { getCliPackageDirectory } from "../package-version.js";

export type InstallMethod =
  | { readonly kind: "script"; readonly installDir: string }
  | { readonly kind: "npm"; readonly prefix: string }
  | { readonly kind: "other" };

export type ManagedInstallMethod = Exclude<InstallMethod, { kind: "other" }>;

interface InstallLocation {
  readonly packageDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export function detectInstallMethod({
  packageDirectory = getCliPackageDirectory(),
  env = process.env,
  platform = process.platform,
}: InstallLocation = {}): InstallMethod {
  const path = platform === "win32" ? win32 : posix;
  try {
    const directory = realpathSync.native(packageDirectory);
    const modules = path.dirname(directory);
    if (
      path.basename(directory).toLowerCase() !== "ohbaby-cli" ||
      path.basename(modules).toLowerCase() !== "node_modules"
    ) {
      return { kind: "other" };
    }

    const parent = path.dirname(modules);
    const releases = path.dirname(parent);
    const installDir = path.dirname(releases);
    const configuredDir = env.OHBABY_INSTALL_DIR;
    if (
      configuredDir &&
      path.isAbsolute(configuredDir) &&
      path.basename(releases) === "releases" &&
      path.relative(realpathSync.native(configuredDir), installDir) === ""
    ) {
      return { kind: "script", installDir };
    }

    if (platform === "win32" && isNpmWindowsShim(parent)) {
      return { kind: "npm", prefix: parent };
    }
    if (
      platform !== "win32" &&
      path.basename(parent) === "lib" &&
      !directory.split("/").includes(".volta")
    ) {
      const prefix = path.dirname(parent);
      const launcher = realpathSync.native(path.join(prefix, "bin", "ohbaby"));
      if (launcher === path.join(directory, "dist", "bin.js")) {
        return { kind: "npm", prefix };
      }
    }
  } catch {
    // A missing or inaccessible installation cannot be safely managed.
  }
  return { kind: "other" };
}

function isNpmWindowsShim(prefix: string): boolean {
  const shim = readFileSync(
    win32.join(prefix, "ohbaby.cmd"),
    "utf8",
  ).toLowerCase();
  return (
    shim.includes("goto #_undefined_#") &&
    shim.includes("%dp0%\\node_modules\\ohbaby-cli\\dist\\bin.js")
  );
}
