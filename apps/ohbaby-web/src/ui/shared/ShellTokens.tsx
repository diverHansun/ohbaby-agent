import type { ReactElement } from "react";
import { tokenizeShell } from "./shell-tokens.js";

/**
 * A shell command coloured like an editor: command names, strings, variables,
 * flags and operators each take their `--syntax-*` colour. Wrap it in the
 * element the place needs (a `pre`, a one-line span).
 */
export function ShellTokens(props: { readonly command: string }): ReactElement {
  return (
    <>
      {tokenizeShell(props.command).map((token, index) =>
        token.kind === "text" ? (
          token.text
        ) : (
          <span className={`ohb-sh-${token.kind}`} key={index}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}
