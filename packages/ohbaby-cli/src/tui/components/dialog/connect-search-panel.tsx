import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiRunStatus,
  UiSetSearchApiKeyInput,
  UiSetSearchApiKeyResult,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { useTheme } from "../../theme/index.js";

type SearchFieldKey = "provider" | "apiKeyEnv" | "apiKey";

interface SearchField {
  readonly key: SearchFieldKey;
  readonly label: string;
  readonly secret?: boolean;
}

interface SearchDraft {
  readonly provider: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string;
}

interface PendingSave {
  readonly input: UiSetSearchApiKeyInput;
  readonly key: string;
  readonly secret?: string;
}

type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly envPath: string }
  | { readonly kind: "error"; readonly message: string };

const SEARCH_FIELDS: readonly SearchField[] = [
  { key: "provider", label: "Provider" },
  { key: "apiKeyEnv", label: "API key env" },
  { key: "apiKey", label: "API key value", secret: true },
];

const EMPTY_DRAFT: SearchDraft = {
  apiKey: "",
  apiKeyEnv: "TAVILY_API_KEY",
  provider: "tavily",
};

export interface ConnectSearchPanelProps {
  readonly client: CoreAPI;
  readonly onClose: () => void;
  readonly runtime: UiRunStatus;
}

export function ConnectSearchPanel({
  client,
  onClose,
  runtime,
}: ConnectSearchPanelProps): ReactElement {
  const [draft, setDraft] = useState<SearchDraft>(EMPTY_DRAFT);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingField, setEditingField] = useState<SearchFieldKey | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const draftRef = useRef<SearchDraft>(EMPTY_DRAFT);
  const editingFieldRef = useRef<SearchFieldKey | null>(null);
  const editValueRef = useRef("");
  const lastSavedPayloadKeyRef = useRef<string | null>(null);
  const inFlightSaveKeyRef = useRef<string | null>(null);
  const latestSaveKeyRef = useRef<string | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const lastSavedEnvPathRef = useRef<string | null>(null);
  const lastSavedWroteSecretRef = useRef(false);

  const selectedField =
    SEARCH_FIELDS[Math.min(selectedIndex, SEARCH_FIELDS.length - 1)];
  const isRunning = runtime.kind === "running";

  const replaceEditValue = (nextValue: string): void => {
    editValueRef.current = nextValue;
    setEditValue(nextValue);
  };

  const replaceEditingField = (nextField: SearchFieldKey | null): void => {
    editingFieldRef.current = nextField;
    setEditingField(nextField);
  };

  const replaceDraft = (nextDraft: SearchDraft): void => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  const startSave = (save: PendingSave): void => {
    inFlightSaveKeyRef.current = save.key;
    setSaveState({ kind: "saving" });
    void client
      .setSearchApiKey(save.input)
      .then((result) => {
        const wroteSecret = save.input.apiKey !== undefined;
        lastSavedPayloadKeyRef.current = save.key;
        lastSavedEnvPathRef.current = result.envPath;
        lastSavedWroteSecretRef.current = wroteSecret;
        if (pendingSaveRef.current === null) {
          setSaveState(
            latestSaveKeyRef.current === save.key
              ? savedState(result, wroteSecret)
              : { kind: "idle" },
          );
        }
      })
      .catch((caught: unknown) => {
        if (
          pendingSaveRef.current === null &&
          latestSaveKeyRef.current === save.key
        ) {
          setSaveState({
            kind: "error",
            message: sanitizeError(caught, save.secret),
          });
        }
      })
      .finally(() => {
        if (inFlightSaveKeyRef.current === save.key) {
          inFlightSaveKeyRef.current = null;
        }
        const pending = pendingSaveRef.current;
        if (pending !== null) {
          pendingSaveRef.current = null;
          if (pending.key === lastSavedPayloadKeyRef.current) {
            setSaveState(
              lastSavedEnvPathRef.current === null
                ? { kind: "idle" }
                : savedState(
                    { envPath: lastSavedEnvPathRef.current },
                    lastSavedWroteSecretRef.current,
                  ),
            );
            return;
          }
          startSave(pending);
        }
      });
  };

  const maybeSave = (nextDraft: SearchDraft): void => {
    const payload = buildPayload(nextDraft);
    if (payload.kind === "incomplete") {
      latestSaveKeyRef.current = null;
      pendingSaveRef.current = null;
      if (inFlightSaveKeyRef.current === null) {
        setSaveState({ kind: "idle" });
      }
      return;
    }
    if (payload.kind === "error") {
      latestSaveKeyRef.current = null;
      pendingSaveRef.current = null;
      setSaveState({ kind: "error", message: payload.message });
      return;
    }
    if (isRunning) {
      return;
    }

    const payloadKey = JSON.stringify(payload.input);
    latestSaveKeyRef.current = payloadKey;
    if (payloadKey === lastSavedPayloadKeyRef.current) {
      pendingSaveRef.current = null;
      setSaveState(
        lastSavedEnvPathRef.current === null
          ? { kind: "idle" }
          : savedState(
              { envPath: lastSavedEnvPathRef.current },
              lastSavedWroteSecretRef.current,
            ),
      );
      return;
    }

    const save = {
      input: payload.input,
      key: payloadKey,
      ...(payload.input.apiKey === undefined
        ? {}
        : { secret: payload.input.apiKey }),
    };
    if (inFlightSaveKeyRef.current !== null) {
      pendingSaveRef.current =
        payloadKey === inFlightSaveKeyRef.current ? null : save;
      setSaveState({ kind: "saving" });
      return;
    }
    startSave(save);
  };

  useInput(
    (value, key) => {
      const isReturn = key.return || value === "\r" || value === "\n";
      const activeEditingField = editingFieldRef.current;
      if (activeEditingField !== null) {
        if (key.escape) {
          replaceEditingField(null);
          replaceEditValue("");
          return;
        }
        if (isReturn) {
          const nextDraft = updateDraft(
            draftRef.current,
            activeEditingField,
            editValueRef.current,
          );
          replaceDraft(nextDraft);
          replaceEditingField(null);
          replaceEditValue("");
          maybeSave(nextDraft);
          return;
        }
        if (key.backspace || key.delete || isBackspaceInput(value)) {
          replaceEditValue(editValueRef.current.slice(0, -1));
          return;
        }
        if (isPrintableInput(value) && !key.ctrl && !key.meta) {
          replaceEditValue(editValueRef.current + value);
        }
        return;
      }

      if (key.escape) {
        onClose();
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((current) => (current + 1) % SEARCH_FIELDS.length);
        return;
      }
      if (key.upArrow) {
        setSelectedIndex(
          (current) =>
            (current - 1 + SEARCH_FIELDS.length) % SEARCH_FIELDS.length,
        );
        return;
      }
      if (isReturn) {
        replaceEditingField(selectedField.key);
        replaceEditValue(draftRef.current[selectedField.key]);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        {SEARCH_FIELDS.map((field, index) => (
          <SearchFieldRow
            draft={draft}
            editValue={editValue}
            editingField={editingField}
            field={field}
            isSelected={index === selectedIndex}
            key={field.key}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <SearchStatusLine isRunning={isRunning} saveState={saveState} />
      </Box>
    </Box>
  );
}

function SearchFieldRow({
  draft,
  editValue,
  editingField,
  field,
  isSelected,
}: {
  readonly draft: SearchDraft;
  readonly editValue: string;
  readonly editingField: SearchFieldKey | null;
  readonly field: SearchField;
  readonly isSelected: boolean;
}): ReactElement {
  const theme = useTheme();
  const isEditing = editingField === field.key;
  const rawValue = isEditing ? editValue : draft[field.key];
  const displayValue = field.secret ? maskSecret(rawValue) : rawValue;
  const prefix = isSelected ? "> " : "  ";
  const label = field.label.padEnd(18, " ");

  return (
    <Text color={isSelected ? theme.text.strong : undefined}>
      {prefix}
      <Text bold>{label}</Text>
      {displayValue}
    </Text>
  );
}

function SearchStatusLine({
  isRunning,
  saveState,
}: {
  readonly isRunning: boolean;
  readonly saveState: SaveState;
}): ReactElement {
  const theme = useTheme();

  if (isRunning) {
    return <Text color={theme.status.warning}>running - save disabled</Text>;
  }
  switch (saveState.kind) {
    case "saving":
      return <Text color={theme.status.running}>saving</Text>;
    case "saved":
      return (
        <Text color={theme.status.success}>
          saved to {formatEnvPath(saveState.envPath)}
        </Text>
      );
    case "error":
      return <Text color={theme.status.error}>{saveState.message}</Text>;
    case "idle":
      return <Text> </Text>;
  }
}

function savedState(
  result: Pick<UiSetSearchApiKeyResult, "envPath">,
  wroteSecret: boolean,
): SaveState {
  return wroteSecret
    ? { envPath: result.envPath, kind: "saved" }
    : { kind: "idle" };
}

type PayloadBuildResult =
  | { readonly kind: "incomplete" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly input: UiSetSearchApiKeyInput };

function buildPayload(draft: SearchDraft): PayloadBuildResult {
  const provider = draft.provider.trim().toLowerCase();
  const apiKeyEnv = draft.apiKeyEnv.trim();
  const apiKey = draft.apiKey.trim();

  if (!provider || !apiKeyEnv) {
    return { kind: "incomplete" };
  }
  if (provider !== "tavily") {
    return { kind: "error", message: "Provider must be tavily" };
  }

  return {
    input: {
      ...(apiKey === "" ? {} : { apiKey }),
      apiKeyEnv,
      provider: "tavily",
    },
    kind: "ready",
  };
}

function updateDraft(
  draft: SearchDraft,
  field: SearchFieldKey,
  value: string,
): SearchDraft {
  return {
    ...draft,
    [field]: value.trim(),
  };
}

function maskSecret(value: string): string {
  return "*".repeat(value.length);
}

function isBackspaceInput(value: string): boolean {
  return value === "\b" || value === "\u007F";
}

function isPrintableInput(value: string): boolean {
  if (value === "") {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return false;
    }
  }
  return true;
}

function sanitizeError(error: unknown, secret?: string): string {
  const message =
    error instanceof Error ? error.message : "Search connection failed";
  const withoutExactSecret =
    secret && secret.trim() !== ""
      ? message.split(secret).join("[redacted]")
      : message;
  return withoutExactSecret
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token)=)[^&\s)]+/giu,
      "$1[redacted]",
    )
    .replace(/\btvly-[A-Za-z0-9_-]{8,}\b/gu, "tvly-[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[redacted]");
}

function formatEnvPath(envPath: string): string {
  const normalized = envPath.replace(/\\/gu, "/");
  const marker = ".ohbaby/";
  const index = normalized.lastIndexOf(marker);
  return index === -1 ? normalized : `~/${normalized.slice(index)}`;
}
