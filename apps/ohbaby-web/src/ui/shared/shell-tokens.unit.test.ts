import { expect, it } from "vitest";
import { tokenizeShell } from "./shell-tokens.js";

const kinds = (source: string): string[] =>
  tokenizeShell(source)
    .filter((token) => token.text.trim() !== "")
    .map((token) => `${token.kind}:${token.text}`);

it("keeps the command text exactly as it will run", () => {
  const source = `cd "/tmp/a b" && FOO=1 sudo rm -rf $HOME/x 2>&1 | tee out.log; echo 'done'\nls`;
  expect(
    tokenizeShell(source)
      .map((token) => token.text)
      .join(""),
  ).toBe(source);
});

it("colours each command, its flags, strings, variables and operators", () => {
  expect(
    kinds(`cd "/tmp/a b" && FOO=1 sudo rm -rf $HOME/x 2>&1 | tee out.log`),
  ).toEqual([
    "command:cd",
    'string:"/tmp/a b"',
    "operator:&&",
    "text:FOO=1",
    "command:sudo",
    "command:rm",
    "flag:-rf",
    "variable:$HOME",
    "text:/x",
    "operator:2>&1",
    "operator:|",
    "command:tee",
    "text:out.log",
  ]);
});

it("treats a redirection target as a file and a new line as a new command", () => {
  expect(kinds("echo hi > out.txt\nls -la")).toEqual([
    "command:echo",
    "text:hi",
    "operator:>",
    "text:out.txt",
    "command:ls",
    "flag:-la",
  ]);
});

it("leaves an unterminated string as one string token", () => {
  expect(kinds(`echo "unterminated && rm`)).toEqual([
    "command:echo",
    'string:"unterminated && rm',
  ]);
});
