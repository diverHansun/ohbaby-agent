import { isAbsolute, posix, relative, sep, win32 } from "node:path";
import type { ManagedInstallMethod } from "./install-method.js";

export const PATH_START = "# >>> ohbaby installer >>>";
export const PATH_END = "# <<< ohbaby installer <<<";

export type UninstallAction =
  | { readonly kind: "npm"; readonly prefix: string }
  | {
      readonly kind: "shell-config" | "fish-config" | "launcher" | "directory";
      readonly path: string;
    }
  | { readonly kind: "windows-path" | "windows-manual"; readonly path: string };

export function planUninstall(
  method: ManagedInstallMethod,
  platform: NodeJS.Platform,
  homeDirectory: string,
): readonly UninstallAction[] {
  if (method.kind === "npm") return [{ kind: "npm", prefix: method.prefix }];
  if (platform === "win32") {
    return [
      { kind: "windows-path", path: win32.join(method.installDir, "bin") },
      { kind: "windows-manual", path: method.installDir },
    ];
  }
  return [
    { kind: "shell-config", path: posix.join(homeDirectory, ".zshrc") },
    { kind: "shell-config", path: posix.join(homeDirectory, ".bashrc") },
    ...(platform === "darwin"
      ? [
          {
            kind: "shell-config" as const,
            path: posix.join(homeDirectory, ".bash_profile"),
          },
        ]
      : []),
    {
      kind: "fish-config",
      path: posix.join(
        homeDirectory,
        ".config",
        "fish",
        "conf.d",
        "ohbaby.fish",
      ),
    },
    {
      kind: "launcher",
      path: posix.join(homeDirectory, ".local", "bin", "ohbaby"),
    },
    { kind: "directory", path: method.installDir },
  ];
}

export function describeUninstallAction(action: UninstallAction): string {
  switch (action.kind) {
    case "npm":
      return `Uninstall the global ohbaby-cli package from ${action.prefix}.`;
    case "shell-config":
    case "fish-config":
      return `Remove the installer's PATH block from ${action.path}, if present.`;
    case "launcher":
      return `Remove the ohbaby launcher at ${action.path}, if it belongs to this installation.`;
    case "directory":
      return `Remove the installation directory at ${action.path}.`;
    case "windows-path":
      return `Remove ${action.path} from the user PATH.`;
    case "windows-manual":
      return `Print instructions to delete ${action.path} after this command exits.`;
  }
}

export function containsPath(parent: string, child: string): boolean {
  const offset = relative(parent, child);
  return (
    offset === "" ||
    (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))
  );
}
