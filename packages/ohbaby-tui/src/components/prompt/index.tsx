import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  getSlashCompletion,
  getSlashCompletionCandidates,
} from "../../command/completions.js";
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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef("");
  const selectedIndexRef = useRef(0);

  const replaceInput = (nextInput: string): void => {
    inputRef.current = nextInput;
    setInput(nextInput);
  };

  const selectIndex = (index: number): void => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  };

  useInput(
    (value, key) => {
      const currentInput = inputRef.current;
      const candidates = getSlashCompletionCandidates(currentInput, catalog);

      if (key.return) {
        submitInput(
          currentInput,
          activeSessionId,
          catalog,
          client,
          replaceInput,
          setError,
          selectedIndexRef.current,
        );
        return;
      }

      if (currentInput.startsWith("/") && candidates.length > 0) {
        if (key.upArrow) {
          selectIndex(
            (selectedIndexRef.current - 1 + candidates.length) %
              candidates.length,
          );
          return;
        }

        if (key.downArrow) {
          selectIndex((selectedIndexRef.current + 1) % candidates.length);
          return;
        }
      }

      if (key.tab && !key.shift) {
        replaceInput(getSlashCompletion(currentInput, catalog));
        selectIndex(0);
        return;
      }

      if (value === "\u0015" || (key.ctrl && value === "u")) {
        replaceInput("");
        selectIndex(0);
        setError(null);
        return;
      }

      if (key.backspace || key.delete) {
        replaceInput(currentInput.slice(0, -1));
        selectIndex(0);
        return;
      }

      if (value.length > 0 && !key.ctrl && !key.meta) {
        replaceInput(`${currentInput}${value}`);
        selectIndex(0);
        setError(null);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Text>
        ohbaby {">"} {input}
      </Text>
      {error === null ? null : <Text color="red">{error}</Text>}
      <Completion
        catalog={catalog}
        input={input}
        selectedIndex={selectedIndex}
      />
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
  selectedIndex: number,
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
  const candidates = getSlashCompletionCandidates(text, catalog);
  const selected =
    candidates.length > 0
      ? candidates[selectedIndex % candidates.length]
      : null;
  const selectedOverridesExact =
    result.kind === "resolved" &&
    selectedIndex > 0 &&
    selected !== null &&
    selected.id !== result.command.id;

  if ((result.kind !== "resolved" || selectedOverridesExact) && selected) {
    const selectedResult = resolveCommand(
      parseSlashInput(`/${selected.path.join(" ")}`),
      catalog,
      {
        sessionId: activeSessionId ?? undefined,
        surface: "tui",
      },
    );
    if (selectedResult.kind === "resolved") {
      setError(null);
      replaceInput("");
      void client
        .executeCommand(selectedResult.invocation)
        .catch((caught: unknown) => {
          setError(formatError(caught));
        });
      return;
    }
  }

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
