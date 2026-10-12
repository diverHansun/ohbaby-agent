import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
declare const OHBABY_SHELL_GRAMMAR_ASSETS: string | undefined;
import { Parser, Language, type Node } from "web-tree-sitter";
import { classifyShellCommandDetail } from "../command-classifier.js";
import { extractShellPathFacts } from "../path-args.js";
import type { ShellKind } from "../preflight.js";
import { computeShellArityKey } from "./arity.js";
import type { ShellAnalysisResult, ShellCommandAnalysis } from "./types.js";

const require = createRequire(import.meta.url);
let initialized: Promise<void> | undefined;
const languages: Partial<Record<"bash" | "powershell", Promise<Language>>> = {};
async function loadLanguage(kind: "bash" | "powershell"): Promise<Language> {
  try {
    initialized ??= Parser.init();
    await initialized;
    const asset =
      typeof OHBABY_SHELL_GRAMMAR_ASSETS === "undefined"
        ? require.resolve(`tree-sitter-${kind}/tree-sitter-${kind}.wasm`)
        : fileURLToPath(
            new URL(
              `${OHBABY_SHELL_GRAMMAR_ASSETS}tree-sitter-${kind}.wasm`,
              import.meta.url,
            ),
          );
    languages[kind] ??= Language.load(asset);
    return await languages[kind];
  } catch (cause) {
    throw new Error(
      `Shell analysis unavailable: ${kind} parser/WASM could not load. Reinstall application dependencies.`,
      { cause },
    );
  }
}
const DYNAMIC_NODES = new Set([
  "simple_expansion",
  "expansion",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
  "variable",
  "sub_expression",
]);
const DIRECTORY_COMMANDS = new Set([
  "cd",
  "chdir",
  "push-location",
  "pushd",
  "set-location",
  "sl",
]);
const WRAPPERS = new Set(["env", "sudo", "command", "nohup", "exec", "time"]);
const WRAPPER_VALUE_OPTIONS = new Set([
  "-u",
  "-g",
  "-h",
  "-p",
  "-C",
  "--unset",
  "--user",
  "--group",
  "--host",
  "--chdir",
]);
const CONTAINERS = new Set([
  "program",
  "statement_list",
  "list",
  "redirected_statement",
  "command_elements",
  "pipeline_chain",
  "empty_statement",
  "comment",
]);
function namedChildren(node: Node | null | undefined): Node[] {
  return (
    node?.namedChildren.filter((child): child is Node => child !== null) ?? []
  );
}
function children(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null);
}
function hasDynamic(node: Node): boolean {
  return DYNAMIC_NODES.has(node.type) || namedChildren(node).some(hasDynamic);
}
function decodePosix(value: string, quoted: boolean): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character !== "\\" || i + 1 === value.length) {
      output += character;
      continue;
    }
    const next = value[i + 1];
    if (next === "\n") {
      i += 1;
      continue;
    }
    if (!quoted || '\\$`"'.includes(next)) {
      output += next;
      i += 1;
    } else output += character;
  }
  return output;
}
/** Decode only AST-proven literal values; never evaluate shell expressions. */
function literal(node: Node, powershell: boolean): string | undefined {
  if (hasDynamic(node) || node.hasError || node.isMissing) return undefined;
  const value = node.text;
  if (powershell) {
    if (node.type === "verbatim_string_characters")
      return value.slice(1, -1).replaceAll("''", "'");
    if (node.type === "expandable_string_literal")
      return value
        .slice(1, -1)
        .replace(
          /`(.)/gu,
          (_match, character: string) =>
            ({ n: "\n", r: "\r", t: "\t", "0": "\0" })[character] ?? character,
        );
    if (
      [
        "command_name",
        "generic_token",
        "command_parameter",
        "decimal_integer_literal",
      ].includes(node.type)
    )
      return value.replace(
        /`(.)/gu,
        (_match, character: string) =>
          ({ n: "\n", r: "\r", t: "\t", "0": "\0" })[character] ?? character,
      );
    if (node.namedChildCount === 1)
      return literal(namedChildren(node)[0], true);
    return undefined;
  }
  if (node.type === "raw_string") return value.slice(1, -1);
  if (node.type === "string") return decodePosix(value.slice(1, -1), true);
  if (node.type === "word" && value.startsWith("~")) return undefined;
  if (node.type === "word" || node.type === "number")
    return decodePosix(value, false);
  if (node.type === "concatenation") {
    const parts = namedChildren(node).map((child) => literal(child, false));
    return parts.every((part) => part !== undefined)
      ? parts.join("")
      : undefined;
  }
  if (node.type === "command_name" && node.namedChildCount === 1)
    return literal(namedChildren(node)[0], false);
  return undefined;
}
function unwrap(tokens: readonly string[]): {
  tokens: readonly string[];
  sudo: boolean;
  cwdUnknown: boolean;
} {
  let index = 0;
  let sudo = false;
  let cwdUnknown = false;
  while (WRAPPERS.has(tokens[index]?.toLowerCase())) {
    const wrapper = tokens[index].toLowerCase();
    sudo ||= wrapper === "sudo";
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === "--") {
        index += 1;
        break;
      }
      if (/^[A-Za-z_][\w]*=/u.test(token)) {
        index += 1;
        continue;
      }
      if (!token.startsWith("-")) break;
      if (
        wrapper === "env" &&
        (token === "-C" ||
          token.startsWith("-C") ||
          token === "--chdir" ||
          token.startsWith("--chdir="))
      )
        cwdUnknown = true;
      index += WRAPPER_VALUE_OPTIONS.has(token) ? 2 : 1;
    }
  }
  return { tokens: tokens.slice(index), sudo, cwdUnknown };
}
function changeDirectory(
  cwd: string | undefined,
  target: string,
): string | undefined {
  if (path.win32.isAbsolute(target) && /^[A-Za-z]:|^\\\\/u.test(target))
    return path.win32.normalize(target);
  if (target.startsWith("/") || target.startsWith("~")) return target;
  return cwd === undefined
    ? undefined
    : path.posix.normalize(path.posix.join(cwd, target));
}
interface WalkContext {
  cwd: string | undefined;
  conditional: boolean;
  pipelineId?: number;
}
export async function analyzeShellCommand(
  command: string,
  shellKind: ShellKind,
): Promise<ShellAnalysisResult> {
  if (shellKind === "cmd")
    return {
      shellKind,
      commands: [],
      completeness: "incomplete",
      incompleteReasons: ["cmd has no reliable grammar."],
    };
  const powershell = shellKind === "powershell";
  const language = await loadLanguage(powershell ? "powershell" : "bash");
  const parser = new Parser();
  const commands: ShellCommandAnalysis[] = [];
  const reasons = new Set<string>();
  let pipelineId = 0;
  try {
    parser.setLanguage(language);
    const tree = parser.parse(command);
    if (!tree)
      throw new Error(
        "Shell analysis unavailable: parser returned no syntax tree.",
      );
    try {
      if (tree.rootNode.hasError)
        reasons.add("Parser recovered unsupported or incomplete syntax.");
      function walk(
        node: Node,
        context: WalkContext,
        redirects: readonly Node[] = [],
      ): void {
        if (node.type === "list") {
          const or = children(node).some((child) => child.text === "||");
          if (or)
            reasons.add("OR control flow makes directory changes uncertain.");
          const nested = { ...context, conditional: context.conditional || or };
          for (const [i, child] of namedChildren(node).entries())
            walk(
              child,
              nested,
              i === namedChildren(node).length - 1 ? redirects : [],
            );
          if (nested.cwd !== context.cwd) context.cwd = undefined;
          return;
        }
        if (
          node.type === "pipeline" ||
          (powershell && node.type === "pipeline_chain")
        ) {
          if (
            powershell &&
            node.descendantsOfType("pipeline_chain_tail").length
          ) {
            reasons.add("PowerShell conditional pipeline is incomplete.");
            const nested = { ...context, conditional: true };
            for (const [i, child] of namedChildren(node).entries())
              walk(
                child,
                nested,
                i === namedChildren(node).length - 1 ? redirects : [],
              );
            context.cwd = undefined;
            return;
          }
          const piped = powershell
            ? children(node).some((child) => child.text === "|")
            : namedChildren(node).length > 1;
          const nested = {
            ...context,
            pipelineId: piped ? ++pipelineId : context.pipelineId,
          };
          for (const [i, child] of namedChildren(node).entries())
            walk(
              child,
              nested,
              i === namedChildren(node).length - 1 ? redirects : [],
            );
          if (
            piped &&
            commands.some(
              (item) => item.pipelineId === nested.pipelineId && item.cdTarget,
            )
          ) {
            reasons.add("Directory change in a pipeline.");
            context.cwd = undefined;
          } else context.cwd = nested.cwd;
          return;
        }
        if (node.type === "redirected_statement") {
          const body = node.childForFieldName("body");
          if (body)
            walk(
              body,
              context,
              namedChildren(node).filter((child) => child !== body),
            );
          return;
        }
        if (node.type === "command") {
          const name =
            node.childForFieldName(powershell ? "command_name" : "name") ??
            namedChildren(node).find(
              (child) => child.type === "command_name_expr",
            );
          if (!name) {
            reasons.add("Command name cannot be determined.");
            return;
          }
          const argumentNodes = powershell
            ? namedChildren(node.childForFieldName("command_elements")).filter(
                (child) =>
                  child.type !== "command_argument_sep" &&
                  child.type !== "redirection",
              )
            : node
                .childrenForFieldName("argument")
                .filter((child): child is Node => child !== null);
          const nodes = [name, ...argumentNodes];
          const values: (string | undefined)[] = [];
          const rawTokens: string[] = [];
          for (let i = 0; i < nodes.length; i += 1) {
            const value = literal(nodes[i], powershell);
            const gap =
              i > 0
                ? command.slice(nodes[i - 1].endIndex, nodes[i].startIndex)
                : "";
            if (!powershell && i > 0 && /^(?:\\\r?\n)+$/u.test(gap)) {
              const previous = values.at(-1);
              values[values.length - 1] =
                previous === undefined || value === undefined
                  ? undefined
                  : previous + value;
              rawTokens[rawTokens.length - 1] += value ?? nodes[i].text;
            } else {
              values.push(value);
              rawTokens.push(value ?? nodes[i].text);
            }
          }
          const dynamic =
            hasDynamic(node) || values.some((value) => value === undefined);
          if (dynamic)
            reasons.add("Command or argument uses dynamic expansion.");

          const effective = unwrap(rawTokens);
          const safe = unwrap(values.map((value) => value ?? ""));
          const root = (effective.tokens[0] ?? "")
            .toLowerCase()
            .replace(/\.exe$/u, "");
          if (values[0] === undefined || !root)
            reasons.add("Command name cannot be determined.");
          const commandCwd = effective.cwdUnknown ? undefined : context.cwd;
          if (effective.cwdUnknown)
            reasons.add("Wrapper changes the execution cwd.");
          const facts = extractShellPathFacts({ root, tokens: safe.tokens });
          const paths = [...facts.pathArgs];
          const redirectNodes = [
            ...redirects,
            ...(powershell
              ? namedChildren(
                  node.childForFieldName("command_elements"),
                ).filter((child) => child.type === "redirection")
              : []),
          ];
          let writesFiles = false;
          for (const redirect of redirectNodes) {
            if (redirect.type === "heredoc_redirect") {
              if (hasDynamic(redirect))
                reasons.add("Heredoc uses dynamic expansion.");
              continue;
            }
            const destination =
              redirect.childForFieldName("destination") ??
              namedChildren(redirect).find(
                (child) => child.type === "redirected_file_name",
              );
            const targetNode =
              destination?.type === "redirected_file_name"
                ? namedChildren(destination).find(
                    (child) => child.type !== "command_argument_sep",
                  )
                : destination;
            const target = targetNode
              ? literal(targetNode, powershell)
              : undefined;
            writesFiles ||=
              children(redirect).some((child) =>
                /^(?:\d*|&)>/u.test(child.text),
              ) ||
              (redirect.type === "redirection" &&
                namedChildren(redirect).some(
                  (child) =>
                    child.type === "file_redirection_operator" &&
                    child.text.includes(">"),
                ));
            if (target !== undefined && !/^\d+$/u.test(target))
              paths.push(target);
            else if (target === undefined && targetNode)
              reasons.add("Redirection destination is dynamic.");
          }
          if (
            commandCwd === undefined &&
            paths.some(
              (target) =>
                !path.isAbsolute(target) && !path.win32.isAbsolute(target),
            )
          )
            reasons.add("Relative path has an unknown cwd.");
          if (paths.some((target) => /[*?[\]{}]/u.test(target)))
            reasons.add("Path uses wildcard expansion.");
          if (facts.inlineEval)
            reasons.add("Nested interpreter evaluation is incomplete.");
          const cdTarget = DIRECTORY_COMMANDS.has(root) ? paths[0] : undefined;
          if (
            DIRECTORY_COMMANDS.has(root) &&
            (!cdTarget || context.conditional || dynamic)
          )
            reasons.add("Directory change cannot be determined reliably.");
          commands.push({
            source: node.text,
            tokens: effective.tokens,
            root,
            ...facts,
            pathArgs: [...new Set(paths)],
            arityKey: computeShellArityKey(effective.tokens),
            danger: classifyShellCommandDetail({
              root,
              tokens: effective.tokens,
              writesFiles,
              sudo: effective.sudo,
            }),
            hasDynamic: dynamic,
            cwd: commandCwd,
            cdTarget,
            pipelineId: context.pipelineId,
            downloadTargets: facts.downloadTargets,
          });
          if (DIRECTORY_COMMANDS.has(root))
            context.cwd =
              cdTarget && !context.conditional && !dynamic
                ? changeDirectory(context.cwd, cdTarget)
                : undefined;
          // Substitutions have their own cwd but their static policy facts remain useful.
          for (const child of namedChildren(node))
            if (hasDynamic(child)) walkNestedCommands(child, { ...context });
          return;
        }
        if (
          node.type === "subshell" ||
          node.type === "command_substitution" ||
          node.type === "process_substitution"
        ) {
          reasons.add("Nested shell context is incomplete.");
          const nested = { ...context };
          for (const [i, child] of namedChildren(node).entries())
            walk(
              child,
              nested,
              i === namedChildren(node).length - 1 ? redirects : [],
            );
          return;
        }
        if (!CONTAINERS.has(node.type)) {
          reasons.add(`Unsupported shell structure: ${node.type}.`);
          const nested = { ...context, conditional: true };
          for (const [i, child] of namedChildren(node).entries())
            walk(
              child,
              nested,
              i === namedChildren(node).length - 1 ? redirects : [],
            );
          if (nested.cwd === undefined) context.cwd = undefined;
          return;
        }
        for (const child of namedChildren(node)) {
          const previousCwd = context.cwd;
          walk(child, context);
          if (child.type === "command" && context.cwd !== previousCwd)
            context.cwd = undefined;
        }
      }
      function walkNestedCommands(node: Node, context: WalkContext): void {
        if (node.type === "command") {
          walk(node, context);
          return;
        }
        for (const child of namedChildren(node))
          walkNestedCommands(child, context);
      }
      walk(tree.rootNode, { cwd: ".", conditional: false });
      if (!commands.length && command.trim())
        reasons.add("No reliable command facts were extracted.");
      return {
        shellKind,
        commands,
        completeness: reasons.size ? "incomplete" : "complete",
        incompleteReasons: [...reasons],
      };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
