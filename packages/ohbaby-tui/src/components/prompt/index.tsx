import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { getSlashCompletion } from "../../command/completions.js";
import { parseSlashInput, resolveCommand } from "../../command/runtime.js";
import type {
  TuiBackendClient,
  TuiCommandCatalog,
} from "../../store/snapshot.js";
import { Completion } from "./completion.js";

export interface PromptProps {
  readonly activeSessionId: string | null;
  readonly catalog: TuiCommandCatalog | null;
  readonly client: TuiBackendClient;
  readonly disabled: boolean;
}

export function Prompt({
  activeSessionId,
  catalog,
  client,
  disabled,
}: PromptProps): ReactElement {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef("");
  const pendingRef = useRef(false);

  const replaceInput = (nextInput: string): void => {
    inputRef.current = nextInput;
    setInput(nextInput);
  };

  useInput(
    (value, key) => {
      const currentInput = inputRef.current;

      if (key.return) {
        if (pendingRef.current) {
          return;
        }

        pendingRef.current = true;
        setPending(true);

        void submitInput(
          currentInput,
          activeSessionId,
          catalog,
          client,
          setError,
        )
          .then((submitted) => {
            if (submitted && inputRef.current === currentInput) {
              replaceInput("");
            }
          })
          .catch((caught: unknown) => {
            setError(formatError(caught));
          })
          .finally(() => {
            pendingRef.current = false;
            setPending(false);
          });
        return;
      }

      if (key.tab) {
        replaceInput(getSlashCompletion(currentInput, catalog));
        return;
      }

      if (value === "\u0015" || (key.ctrl && value === "u")) {
        replaceInput("");
        setError(null);
        return;
      }

      if (key.backspace || key.delete) {
        replaceInput(currentInput.slice(0, -1));
        return;
      }

      if (value.length > 0 && !key.ctrl && !key.meta) {
        replaceInput(`${currentInput}${value}`);
        setError(null);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Text>
        {pending ? "..." : ">"} {input}
      </Text>
      {error === null ? null : <Text color="red">{error}</Text>}
      <Completion catalog={catalog} input={input} />
    </Box>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Command failed";
}

async function submitInput(
  input: string,
  activeSessionId: string | null,
  catalog: TuiCommandCatalog | null,
  client: TuiBackendClient,
  setError: (message: string | null) => void,
): Promise<boolean> {
  const text = input.trim();

  if (text === "") {
    return false;
  }

  if (!text.startsWith("/")) {
    await client.submitPrompt(text, {
      sessionId: activeSessionId ?? undefined,
    });
    return true;
  }

  if (catalog === null) {
    setError("Command catalog is not loaded");
    return false;
  }

  const result = resolveCommand(parseSlashInput(text), catalog, {
    sessionId: activeSessionId ?? undefined,
    surface: "tui",
  });

  if (result.kind !== "resolved") {
    setError(result.reason);
    return false;
  }

  await client.executeCommand(result.invocation);
  return true;
}
