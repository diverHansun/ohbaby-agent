import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ShellCommandAnalysis } from "./types.js";

// Check the original tree before relying on normalized argv (which strips wrappers).
export function isDefaultApprovalNode(node: Node): boolean {
  if (node.type === "redirected_statement" && !node.childForFieldName("body"))
    return false;
  switch (node.type) {
    case "program":
      return node.childCount === 1;
    case "list":
      return node.childCount === 3 && node.child(1)?.type === "&&";
    case "redirected_statement":
    case "command":
      return node.children.every((child, i) => {
        if (!child) return false;
        switch (node.fieldNameForChild(i)) {
          case "body":
          case "name":
            return true;
          case "argument":
            // Path preflight normalizes before resolving symlinks. A parent segment after another component can name a different file.
            if (/\/\.\.(?:\/|['"]?$)/u.test(child.text)) return false;
            // The POSIX shell can expand words even when the Bash grammar calls them literal.
            return (
              child.type === "raw_string" ||
              child.type === "string" ||
              /^[\p{L}\p{N}._/+~-]+$/u.test(child.text)
            );
          case "redirect":
            return (
              child.type === "file_redirect" &&
              /^(?:\d*(?:>>?|>\||&>>?)[ \t]*\/dev\/null|\d*>&[ \t]*(?:\d+|-))$/u.test(
                child.text,
              )
            );
          default:
            return false;
        }
      });
    default:
      return false;
  }
}

export function isDefaultApprovalCommand(
  command: ShellCommandAnalysis,
  followedByCommand: boolean,
  workdir?: string,
): boolean {
  const [name, ...args] = command.tokens;
  if (command.cwd === undefined || command.root !== name) return false;
  const operand = args.at(-1);
  // Only approve file operands that are represented in the existing path preflight.
  const hasPath =
    !!operand && !operand.startsWith("-") && command.pathArgs.includes(operand);
  // File utilities open .. relative to the physical directory, even after a logical cd.
  if (
    !(name === "cd" && operand === "..") &&
    command.cwd !== "." &&
    operand &&
    /^(?:\.\/)*\.\.(?:\/|$)/u.test(operand)
  )
    return false;
  switch (name) {
    case "pwd":
      return args.length === 0;
    case "cd":
      return (
        followedByCommand &&
        args.length === 1 &&
        hasPath &&
        !operand.startsWith("+")
      );
    case "cat":
      return args.length === 1 && hasPath;
    case "ls":
      return (
        args.length === 0 ||
        (args.length === 1 && (args[0] === "-la" || hasPath)) ||
        (args.length === 2 && args[0] === "-la" && hasPath)
      );
    case "head":
    case "tail":
      return (
        args.length === 3 &&
        args[0] === "-n" &&
        /^\d+$/u.test(args[1]) &&
        hasPath
      );
    case "wc":
      return (
        args[0] === "-l" &&
        (args.length === 1 || (args.length === 2 && hasPath))
      );
    case "git":
      if (
        command.cwd !== "." &&
        (!workdir ||
          path.resolve(workdir, command.cwd) !== path.resolve(workdir))
      )
        return false;
      return (
        args[0] === "status" &&
        (args.length === 1 ||
          (args.length === 2 &&
            (args[1] === "--short" || args[1] === "--porcelain")) ||
          (args.length === 3 &&
            args[1] === "--short" &&
            args[2] === "--branch"))
      );
    default:
      return false;
  }
}
