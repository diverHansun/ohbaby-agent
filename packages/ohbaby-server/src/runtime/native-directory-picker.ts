import { spawn } from "node:child_process";

export type NativeDirectoryPickerErrorCode =
  | "DIRECTORY_PICKER_FAILED"
  | "DIRECTORY_PICKER_UNSUPPORTED";

export class NativeDirectoryPickerError extends Error {
  constructor(
    readonly code: NativeDirectoryPickerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeDirectoryPickerError";
  }
}

export interface NativeDirectoryPicker {
  pickDirectory(): Promise<string | undefined>;
}

export interface NativeDirectoryPickerCommand {
  readonly args: readonly string[];
  readonly command: string;
}

export interface NativeDirectoryPickerCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type NativeDirectoryPickerCommandRunner = (
  command: NativeDirectoryPickerCommand,
) => Promise<NativeDirectoryPickerCommandResult>;

export interface CreateNativeDirectoryPickerOptions {
  readonly commandRunner?: NativeDirectoryPickerCommandRunner;
  readonly platform?: NodeJS.Platform;
}

const MACOS_PICK_DIRECTORY_SCRIPT = [
  "try",
  '  set selectedFolder to choose folder with prompt "Open project"',
  "  return POSIX path of selectedFolder",
  "on error number -128",
  '  return ""',
  "end try",
].join("\n");

// FolderBrowserDialog hangs invisibly when Node spawns PowerShell with
// windowsHide/CREATE_NO_WINDOW. Shell.Application.BrowseForFolder still
// surfaces a visible Explorer folder dialog in that configuration.
const WINDOWS_PICK_DIRECTORY_SCRIPT = [
  "$shell = New-Object -ComObject Shell.Application",
  '$folder = $shell.BrowseForFolder(0, "Open project", 0)',
  "if ($folder -ne $null) {",
  "  [Console]::Out.Write($folder.Self.Path)",
  "}",
].join("\n");

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function normalizeSelection(stdout: string): string | undefined {
  const directory = stdout.trim();
  if (directory.length === 0) {
    return undefined;
  }
  // BrowseForFolder may append a trailing separator for ordinary folders.
  // Keep "/" and Windows drive roots (e.g. "C:\") intact.
  if (directory === "/" || /^[A-Za-z]:\\$/.test(directory)) {
    return directory;
  }
  return directory.replace(/[/\\]+$/, "");
}

function failureFor(
  command: NativeDirectoryPickerCommand,
  result: NativeDirectoryPickerCommandResult,
): NativeDirectoryPickerError {
  const detail = result.stderr.trim();
  return new NativeDirectoryPickerError(
    "DIRECTORY_PICKER_FAILED",
    detail.length > 0
      ? `System directory picker failed: ${detail}`
      : `System directory picker command ${command.command} exited with ${String(
          result.exitCode,
        )}`,
  );
}

function isCommandNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function runDirectoryPickerCommand(
  run: NativeDirectoryPickerCommandRunner,
  command: NativeDirectoryPickerCommand,
): Promise<NativeDirectoryPickerCommandResult> {
  try {
    return await run(command);
  } catch (error) {
    throw new NativeDirectoryPickerError(
      "DIRECTORY_PICKER_FAILED",
      "System directory picker could not be started",
      { cause: error },
    );
  }
}

async function runLinuxDirectoryPicker(
  run: NativeDirectoryPickerCommandRunner,
): Promise<string | undefined> {
  const candidates: readonly NativeDirectoryPickerCommand[] = [
    {
      args: ["--file-selection", "--directory", "--title=Open project"],
      command: "zenity",
    },
    {
      args: ["--getexistingdirectory", ".", "--title", "Open project"],
      command: "kdialog",
    },
  ];

  for (const candidate of candidates) {
    let result: NativeDirectoryPickerCommandResult;
    try {
      result = await run(candidate);
    } catch (error) {
      if (isCommandNotFound(error)) {
        continue;
      }
      throw new NativeDirectoryPickerError(
        "DIRECTORY_PICKER_FAILED",
        "System directory picker could not be started",
        { cause: error },
      );
    }
    if (result.exitCode === 0) {
      return normalizeSelection(result.stdout);
    }
    if (result.exitCode === 1) {
      return undefined;
    }
    throw failureFor(candidate, result);
  }

  throw new NativeDirectoryPickerError(
    "DIRECTORY_PICKER_UNSUPPORTED",
    "No supported Linux directory picker was found. Install zenity or kdialog.",
  );
}

export function createNativeDirectoryPicker(
  options: CreateNativeDirectoryPickerOptions = {},
): NativeDirectoryPicker {
  const platform = options.platform ?? process.platform;
  const run = options.commandRunner ?? runNativeDirectoryPickerCommand;
  return {
    async pickDirectory(): Promise<string | undefined> {
      if (platform === "darwin") {
        const command: NativeDirectoryPickerCommand = {
          args: ["-e", MACOS_PICK_DIRECTORY_SCRIPT],
          command: "osascript",
        };
        const result = await runDirectoryPickerCommand(run, command);
        if (result.exitCode !== 0) {
          throw failureFor(command, result);
        }
        return normalizeSelection(result.stdout);
      }

      if (platform === "win32") {
        const command: NativeDirectoryPickerCommand = {
          args: [
            "-NoProfile",
            "-STA",
            "-EncodedCommand",
            encodePowerShellCommand(WINDOWS_PICK_DIRECTORY_SCRIPT),
          ],
          command: "powershell.exe",
        };
        const result = await runDirectoryPickerCommand(run, command);
        if (result.exitCode !== 0) {
          throw failureFor(command, result);
        }
        return normalizeSelection(result.stdout);
      }

      if (platform === "linux") {
        return runLinuxDirectoryPicker(run);
      }

      throw new NativeDirectoryPickerError(
        "DIRECTORY_PICKER_UNSUPPORTED",
        `System directory picking is unsupported on ${platform}`,
      );
    },
  };
}

export function runNativeDirectoryPickerCommand(
  command: NativeDirectoryPickerCommand,
): Promise<NativeDirectoryPickerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stderr, stdout });
    });
  });
}
