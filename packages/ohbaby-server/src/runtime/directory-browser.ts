import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

export type DirectoryBrowserErrorCode =
  | "DIRECTORY_NOT_A_DIRECTORY"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_NOT_READABLE"
  | "INVALID_DIRECTORY";

export class DirectoryBrowserError extends Error {
  constructor(
    readonly code: DirectoryBrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DirectoryBrowserError";
  }
}

export interface DirectoryBrowserRoot {
  readonly directory: string;
  readonly name: string;
}

export interface DirectoryBrowserEntry {
  readonly directory: string;
  readonly name: string;
}

export interface DirectoryBrowserListing {
  readonly children: readonly DirectoryBrowserEntry[];
  readonly directory: string;
  readonly parent: string | null;
}

export interface DirectoryBrowser {
  list(directory: string): Promise<DirectoryBrowserListing>;
  listRoots(): Promise<readonly DirectoryBrowserRoot[]>;
}

type DirectoryEntry = Pick<Dirent, "isDirectory" | "name">;
type DirectoryStat = Pick<Stats, "isDirectory">;

export interface CreateDirectoryBrowserOptions {
  readonly platform?: NodeJS.Platform;
  readonly readdir?: (directory: string) => Promise<readonly DirectoryEntry[]>;
  readonly stat?: (directory: string) => Promise<DirectoryStat>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? ((error as { readonly code?: unknown }).code as string | undefined)
    : undefined;
}

function directoryError(error: unknown): DirectoryBrowserError {
  if (error instanceof DirectoryBrowserError) {
    return error;
  }
  switch (errorCode(error)) {
    case "ENOENT":
      return new DirectoryBrowserError(
        "DIRECTORY_NOT_FOUND",
        "The directory does not exist",
      );
    case "ENOTDIR":
      return new DirectoryBrowserError(
        "DIRECTORY_NOT_A_DIRECTORY",
        "The path is not a directory",
      );
    case "EACCES":
    case "EPERM":
      return new DirectoryBrowserError(
        "DIRECTORY_NOT_READABLE",
        "The directory cannot be read",
      );
    default:
      return new DirectoryBrowserError(
        "DIRECTORY_NOT_READABLE",
        "The directory cannot be read",
      );
  }
}

function resolveDirectory(directory: string, paths: typeof posix): string {
  if (!paths.isAbsolute(directory)) {
    throw new DirectoryBrowserError(
      "INVALID_DIRECTORY",
      "directory must be an absolute path",
    );
  }
  return paths.resolve(directory);
}

function parentDirectory(
  directory: string,
  paths: typeof posix,
): string | null {
  return paths.parse(directory).root === directory
    ? null
    : paths.dirname(directory);
}

export function createDirectoryBrowser(
  options: CreateDirectoryBrowserOptions = {},
): DirectoryBrowser {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const readDirectory =
    options.readdir ??
    ((directory: string): Promise<readonly DirectoryEntry[]> =>
      readdir(directory, { withFileTypes: true }));
  const statDirectory = options.stat ?? stat;

  return {
    async listRoots(): Promise<readonly DirectoryBrowserRoot[]> {
      if (platform !== "win32") {
        return [{ directory: "/", name: "/" }];
      }

      const roots: DirectoryBrowserRoot[] = [];
      for (let charCode = 65; charCode <= 90; charCode += 1) {
        const directory = `${String.fromCharCode(charCode)}:\\`;
        try {
          if ((await statDirectory(directory)).isDirectory()) {
            roots.push({ directory, name: directory });
          }
        } catch {
          // Inaccessible and absent drives must not be visible to the browser.
        }
      }
      return roots.sort((left, right) => left.name.localeCompare(right.name));
    },

    async list(input: string): Promise<DirectoryBrowserListing> {
      let directory: string;
      try {
        directory = resolveDirectory(input, paths);
        if (!(await statDirectory(directory)).isDirectory()) {
          throw new DirectoryBrowserError(
            "DIRECTORY_NOT_A_DIRECTORY",
            "The path is not a directory",
          );
        }
        const children = (await readDirectory(directory))
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            directory: paths.join(directory, entry.name),
            name: entry.name,
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        return {
          children,
          directory,
          parent: parentDirectory(directory, paths),
        };
      } catch (error) {
        throw directoryError(error);
      }
    },
  };
}
