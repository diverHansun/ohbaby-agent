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
  const inputRef = useRef("");

  const replaceInput = (nextInput: string): void => {
    inputRef.current = nextInput;
    setInput(nextInput);
  };

  useInput(
    (value, key) => {
      const currentInput = inputRef.current;

      if (key.return) {
        submitInput(
          currentInput,
          activeSessionId,
          catalog,
          client,
          replaceInput,
          setError,
        );
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
        {">"} {input}
      </Text>
      {error === null ? null : <Text color="red">{error}</Text>}
      <Completion catalog={catalog} input={input} />
    </Box>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Command failed";
}

function submitInput(
  input: string,
  activeSessionId: string | null,
  catalog: TuiCommandCatalog | null,
  client: TuiBackendClient,
  replaceInput: (nextInput: string) => void,
  setError: (message: string | null) => void,
): void {
  const text = input.trim();

  if (text === "") {
    return;
  }

  if (!text.startsWith("/")) {
    setError(null);
    replaceInput("");
    void client
      .submitPrompt(text, {
        sessionId: activeSessionId ?? undefined,
      })
      .catch((caught: unknown) => {
        setError(formatError(caught));
      });
    return;
  }

  if (catalog === null) {
    setError("Command catalog is not loaded");
    return;
  }

  const result = resolveCommand(parseSlashInput(text), catalog, {
    sessionId: activeSessionId ?? undefined,
    surface: "tui",
  });

  if (result.kind !== "resolved") {
    setError(result.reason);
    return;
  }

  setError(null);
  replaceInput("");
  void client.executeCommand(result.invocation).catch((caught: unknown) => {
    setError(formatError(caught));
  });
}
