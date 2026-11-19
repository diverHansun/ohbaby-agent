import { expect, it } from "vitest";
import { findOtherWindowsOhbabyProcesses } from "./windows-processes.js";

it("excludes only its own Windows process chain and the verified daemon", () => {
  const ohbaby = String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\test\node_modules\ohbaby-cli\dist\bin.js"`;
  const unrelated = String.raw`"C:\Program Files\nodejs\node.exe" "C:\app\index.js"`;
  const rows = [
    {
      ProcessId: 10,
      ParentProcessId: 2,
      Name: "node.exe",
      CommandLine: ohbaby,
    },
    {
      ProcessId: 2,
      ParentProcessId: 1,
      Name: "cmd.exe",
      CommandLine: "cmd /c ohbaby.cmd update",
    },
    { ProcessId: 1, ParentProcessId: 0, Name: "powershell.exe" },
    {
      ProcessId: 30,
      ParentProcessId: 31,
      Name: "node.exe",
      CommandLine: ohbaby,
    },
    {
      ProcessId: 31,
      ParentProcessId: 32,
      Name: "cmd.exe",
      CommandLine: "cmd /c ohbaby.cmd serve",
    },
    {
      ProcessId: 32,
      ParentProcessId: 33,
      Name: "pwsh.exe",
      CommandLine: "pwsh -File ohbaby.ps1 serve",
    },
    {
      ProcessId: 33,
      ParentProcessId: 1,
      Name: "node.exe",
      CommandLine: ohbaby,
    },
    {
      ProcessId: 40,
      ParentProcessId: 1,
      Name: "NODE.EXE",
      CommandLine: ohbaby,
    },
    {
      ProcessId: 50,
      ParentProcessId: 1,
      Name: "node.exe",
      CommandLine: unrelated,
    },
    { ProcessId: 60, ParentProcessId: 1, Name: "ohbaby.exe" },
    {
      ProcessId: 70,
      ParentProcessId: 1,
      Name: "cmd.exe",
      CommandLine: "cmd /c ohbaby.cmd",
    },
  ];
  expect(findOtherWindowsOhbabyProcesses(rows, 10, 30)).toEqual([
    33, 40, 60, 70,
  ]);
  expect(findOtherWindowsOhbabyProcesses(rows, 10, undefined)).toEqual([
    30, 31, 32, 33, 40, 60, 70,
  ]);
});
