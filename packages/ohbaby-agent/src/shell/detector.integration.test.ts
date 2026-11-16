import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe.runIf(process.platform === "win32")(
  "Windows Store shell alias",
  () => {
    it("runs an absolute alias inherited as SHELL by a nested runtime", async (context) => {
      const alias = join(
        process.env.LOCALAPPDATA ?? "",
        "Microsoft",
        "WindowsApps",
        "pwsh.exe",
      );
      try {
        lstatSync(alias);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          context.skip();
          return;
        }
        throw error;
      }
      const args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output 'STORE_ALIAS_OK'",
      ];
      // Establish that Windows can execute the alias before testing detection.
      const direct = await execute(alias, args, {
        windowsHide: true,
        timeout: 10000,
      });
      expect(direct.stdout.trim()).toBe("STORE_ALIAS_OK");
      const detector = new URL("./detector.ts", import.meta.url).href;
      const nested = await execute(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "--input-type=module",
          "-e",
          `
      import { execFileSync } from "node:child_process";
      import { resolveAcceptableShell } from ${JSON.stringify(detector)};
      const selected = resolveAcceptableShell();
      const output = execFileSync(selected, ${JSON.stringify(args)}, { windowsHide: true, timeout: 10000, encoding: "utf8" });
      console.log(JSON.stringify({ selected, output: output.trim() }));
    `,
        ],
        {
          env: { ...process.env, SHELL: alias },
          windowsHide: true,
          timeout: 15000,
        },
      );
      expect(JSON.parse(nested.stdout)).toEqual({
        selected: alias,
        output: "STORE_ALIAS_OK",
      });
    }, 30000);
  },
);
