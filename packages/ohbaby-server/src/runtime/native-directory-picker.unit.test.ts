import { describe, expect, it, vi } from "vitest";
import {
  createNativeDirectoryPicker,
  NativeDirectoryPickerError,
  type NativeDirectoryPickerCommandRunner,
} from "./native-directory-picker.js";

function commandNotFound(): Error & { readonly code: "ENOENT" } {
  return Object.assign(new Error("not found"), { code: "ENOENT" as const });
}

describe("createNativeDirectoryPicker", () => {
  it("uses AppleScript and returns the selected macOS directory", async () => {
    const run = vi.fn<NativeDirectoryPickerCommandRunner>(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: " /Users/test/projects/ohbaby\n",
      }),
    );
    const picker = createNativeDirectoryPicker({
      commandRunner: run,
      platform: "darwin",
    });

    await expect(picker.pickDirectory()).resolves.toBe(
      "/Users/test/projects/ohbaby",
    );
    const [command] = run.mock.calls[0];
    expect(command.command).toBe("osascript");
    expect(command.args).toContain("-e");
    expect(command.args.at(-1)).toContain("choose folder");
  });

  it("treats an empty macOS result as cancellation", async () => {
    const picker = createNativeDirectoryPicker({
      commandRunner: () =>
        Promise.resolve({ exitCode: 0, stderr: "", stdout: "\n" }),
      platform: "darwin",
    });

    await expect(picker.pickDirectory()).resolves.toBeUndefined();
  });

  it("returns a structured failure when the macOS dialog cannot start", async () => {
    const picker = createNativeDirectoryPicker({
      commandRunner: () => Promise.reject(commandNotFound()),
      platform: "darwin",
    });

    await expect(picker.pickDirectory()).rejects.toMatchObject({
      code: "DIRECTORY_PICKER_FAILED",
    } satisfies Partial<NativeDirectoryPickerError>);
  });

  it("uses Shell.Application BrowseForFolder on Windows", async () => {
    const run = vi.fn<NativeDirectoryPickerCommandRunner>(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "D:\\Projects\\ohbaby\\",
      }),
    );
    const picker = createNativeDirectoryPicker({
      commandRunner: run,
      platform: "win32",
    });

    await expect(picker.pickDirectory()).resolves.toBe("D:\\Projects\\ohbaby");
    const [command] = run.mock.calls[0];
    expect(command.command).toBe("powershell.exe");
    expect(command.args).toContain("-STA");
    expect(command.args).toContain("-EncodedCommand");
    const encoded = command.args.at(-1);
    expect(encoded).toEqual(expect.any(String));
    if (typeof encoded !== "string") {
      throw new Error("expected EncodedCommand payload");
    }
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("Shell.Application");
    expect(decoded).toContain("BrowseForFolder");
  });

  it("treats an empty Windows result as cancellation", async () => {
    const picker = createNativeDirectoryPicker({
      commandRunner: () =>
        Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
      platform: "win32",
    });

    await expect(picker.pickDirectory()).resolves.toBeUndefined();
  });

  it("preserves Windows drive-root selections", async () => {
    const picker = createNativeDirectoryPicker({
      commandRunner: () =>
        Promise.resolve({ exitCode: 0, stderr: "", stdout: "C:\\" }),
      platform: "win32",
    });

    await expect(picker.pickDirectory()).resolves.toBe("C:\\");
  });

  it("falls back from zenity to kdialog on Linux", async () => {
    const run = vi.fn<NativeDirectoryPickerCommandRunner>((command) => {
      if (command.command === "zenity") {
        return Promise.reject(commandNotFound());
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "/home/test/project\n",
      });
    });
    const picker = createNativeDirectoryPicker({
      commandRunner: run,
      platform: "linux",
    });

    await expect(picker.pickDirectory()).resolves.toBe("/home/test/project");
    expect(run.mock.calls.map(([command]) => command.command)).toEqual([
      "zenity",
      "kdialog",
    ]);
  });

  it("treats a Linux picker exit code of one as cancellation", async () => {
    const picker = createNativeDirectoryPicker({
      commandRunner: () =>
        Promise.resolve({ exitCode: 1, stderr: "", stdout: "" }),
      platform: "linux",
    });

    await expect(picker.pickDirectory()).resolves.toBeUndefined();
  });

  it("reports a clear unsupported error when Linux has no picker", async () => {
    const picker = createNativeDirectoryPicker({
      commandRunner: () => Promise.reject(commandNotFound()),
      platform: "linux",
    });

    await expect(picker.pickDirectory()).rejects.toMatchObject({
      code: "DIRECTORY_PICKER_UNSUPPORTED",
    } satisfies Partial<NativeDirectoryPickerError>);
  });

  it("reports unsupported operating systems without invoking a command", async () => {
    const run = vi.fn<NativeDirectoryPickerCommandRunner>();
    const picker = createNativeDirectoryPicker({
      commandRunner: run,
      platform: "freebsd",
    });

    await expect(picker.pickDirectory()).rejects.toMatchObject({
      code: "DIRECTORY_PICKER_UNSUPPORTED",
    } satisfies Partial<NativeDirectoryPickerError>);
    expect(run).not.toHaveBeenCalled();
  });
});
