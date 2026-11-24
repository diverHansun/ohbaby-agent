export type ShellTokenKind =
  | "command"
  | "flag"
  | "string"
  | "variable"
  | "operator"
  | "text";

export interface ShellToken {
  readonly kind: ShellTokenKind;
  readonly text: string;
}

/** Words that run the next word as the command, so that word is coloured too. */
const PREFIXES = new Set(["sudo", "env", "time", "nohup", "exec", "xargs"]);

const PATTERNS: readonly (readonly [RegExp, ShellTokenKind | "space"])[] = [
  [/^\s+/, "space"],
  [/^'[^']*'?/, "string"],
  [/^"(?:[^"\\]|\\.)*"?/, "string"],
  [/^\$\{[^}]*\}?|^\$[A-Za-z_]\w*|^\$[0-9?#@*$!-]/, "variable"],
  [/^(?:&&|\|\||;;|\d*>>?&?\d*|<<?|[|;&()])/, "operator"],
  [/^[^\s'"|;&<>()$]+/, "text"],
  [/^./, "text"],
];

/**
 * Splits a shell command into display tokens (approval card, background tasks). This only
 * colours the text; it is not a parser, so anything it does not recognise
 * stays plain and the command reads exactly as it will run.
 */
export function tokenizeShell(source: string): readonly ShellToken[] {
  const tokens: ShellToken[] = [];
  let rest = source;
  let expectCommand = true;
  while (rest !== "") {
    for (const [pattern, kind] of PATTERNS) {
      const text = pattern.exec(rest)?.[0];
      if (!text) continue;
      rest = rest.slice(text.length);
      if (kind === "space") {
        if (text.includes("\n")) expectCommand = true;
        tokens.push({ kind: "text", text });
      } else if (kind === "operator") {
        // A redirection target is a file, not a command.
        expectCommand = !/[<>]/.test(text);
        tokens.push({ kind, text });
      } else if (kind === "text" && expectCommand) {
        // FOO=bar before a command is an assignment, not the command.
        if (/^[A-Za-z_]\w*=/.test(text)) {
          tokens.push({ kind: "text", text });
        } else {
          expectCommand = PREFIXES.has(text);
          tokens.push({ kind: "command", text });
        }
      } else {
        expectCommand = false;
        tokens.push({
          kind: kind === "text" && text.startsWith("-") ? "flag" : kind,
          text,
        });
      }
      break;
    }
  }
  return tokens;
}
