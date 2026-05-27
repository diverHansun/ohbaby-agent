import { describe, expect, it } from "vitest";
import { parseCommand } from "../utils/index.js";
import {
  classifyShellCommand,
  type ShellCommandClass,
} from "./command-classifier.js";

describe("classifyShellCommand", () => {
  it.each([
    ["ls", "readonly"],
    ["cat foo.txt", "readonly"],
    ["pwd", "readonly"],
    ["find . -name *.ts", "readonly"],
    ["grep foo file.txt", "readonly"],
    ["head -n 10 file.txt", "readonly"],
    ["tail -n 10 file.txt", "readonly"],
    ["git status", "readonly"],
    ["git log", "readonly"],
    ["git diff", "readonly"],
    ["mv a b", "mutating"],
    ["cp a b", "mutating"],
    ["mkdir foo", "mutating"],
    ["touch foo", "mutating"],
    ["echo hi > foo", "mutating"],
    ["git commit -m x", "mutating"],
    ["npm install", "mutating"],
    ["unknown-command --flag", "mutating"],
    ['bash -c "echo hi"', "mutating"],
    ["xargs echo", "mutating"],
    ["rm -rf foo", "dangerous"],
    ["sudo ls", "dangerous"],
    ["chmod 777 foo", "dangerous"],
    ["chown root foo", "dangerous"],
    ["dd if=a of=b", "dangerous"],
    ["cat a | tee b", "mutating"],
    ["git status && rm -rf foo", "dangerous"],
    ["ls; mkdir foo", "mutating"],
  ] as readonly (readonly [string, ShellCommandClass])[])(
    "classifies %s as %s",
    (command, expected) => {
      expect(classifyShellCommand(parseCommand(command))).toBe(expected);
    },
  );
});
