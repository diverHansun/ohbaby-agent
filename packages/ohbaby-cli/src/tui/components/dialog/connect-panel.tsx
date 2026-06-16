import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiCurrentModelConfig,
  UiConnectModelInput,
  UiConnectModelInterfaceProvider,
  UiRunStatus,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../theme/index.js";

type ConnectFieldKey =
  | "provider"
  | "baseUrl"
  | "apiKeyEnv"
  | "apiKey"
  | "model"
  | "contextWindowTokens"
  | "maxOutputTokens";

interface ConnectField {
  readonly key: ConnectFieldKey;
  readonly label: string;
  readonly optional?: boolean;
  readonly secret?: boolean;
}

interface ConnectDraft {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindowTokens: string;
  readonly maxOutputTokens: string;
}

interface PendingSave {
  readonly input: UiConnectModelInput;
  readonly key: string;
  readonly secret?: string;
}

type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly warning?: string }
  | { readonly kind: "error"; readonly message: string };

const CONNECT_FIELDS: readonly ConnectField[] = [
  { key: "provider", label: "Provider" },
  { key: "baseUrl", label: "Base URL" },
  { key: "apiKeyEnv", label: "API key env" },
  { key: "apiKey", label: "API key value", secret: true },
  { key: "model", label: "Model name" },
  { key: "contextWindowTokens", label: "Context window", optional: true },
  { key: "maxOutputTokens", label: "Max output tokens", optional: true },
];

const EMPTY_DRAFT: ConnectDraft = {
  apiKey: "",
  apiKeyEnv: "",
  baseUrl: "",
  contextWindowTokens: "",
  maxOutputTokens: "",
  model: "",
  provider: "",
};

export interface ConnectPanelProps {
  readonly client: CoreAPI;
  readonly onClose: () => void;
  readonly runtime: UiRunStatus;
}

export function ConnectPanel({
  client,
  onClose,
  runtime,
}: ConnectPanelProps): ReactElement {
  const [draft, setDraft] = useState<ConnectDraft>(EMPTY_DRAFT);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingField, setEditingField] = useState<ConnectFieldKey | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const draftRef = useRef<ConnectDraft>(EMPTY_DRAFT);
  const editingFieldRef = useRef<ConnectFieldKey | null>(null);
  const hasLocalEditRef = useRef(false);
  const editValueRef = useRef("");
  const lastSavedPayloadKeyRef = useRef<string | null>(null);
  const inFlightSaveKeyRef = useRef<string | null>(null);
  const latestSaveKeyRef = useRef<string | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const lastSavedWarningRef = useRef<string | undefined>(undefined);

  const selectedField =
    CONNECT_FIELDS[Math.min(selectedIndex, CONNECT_FIELDS.length - 1)];
  const isRunning = runtime.kind === "running";

  const replaceEditValue = (nextValue: string): void => {
    editValueRef.current = nextValue;
    setEditValue(nextValue);
  };

  const replaceEditingField = (nextField: ConnectFieldKey | null): void => {
    editingFieldRef.current = nextField;
    setEditingField(nextField);
  };

  const replaceDraft = (nextDraft: ConnectDraft): void => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  useEffect(() => {
    let isStale = false;
    void client
      .getCurrentModel()
      .then((current) => {
        if (isStale || current === null || hasLocalEditRef.current) {
          return;
        }
        replaceDraft(draftFromCurrentModel(current));
      })
      .catch(() => undefined);

    return (): void => {
      isStale = true;
    };
  }, [client]);

  const startSave = (save: PendingSave): void => {
    inFlightSaveKeyRef.current = save.key;
    setSaveState({ kind: "saving" });
    void client
      .connectModel(save.input)
      .then((result) => {
        lastSavedPayloadKeyRef.current = save.key;
        lastSavedWarningRef.current = readConnectWarning(result);
        if (pendingSaveRef.current === null) {
          setSaveState(
            latestSaveKeyRef.current === save.key
              ? savedState(lastSavedWarningRef.current)
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
            setSaveState(savedState(lastSavedWarningRef.current));
            return;
          }
          startSave(pending);
        }
      });
  };

  const maybeSave = (nextDraft: ConnectDraft): void => {
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
      setSaveState(savedState(lastSavedWarningRef.current));
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
          hasLocalEditRef.current = true;
          replaceDraft(nextDraft);
          replaceEditingField(null);
          replaceEditValue("");
          maybeSave(nextDraft);
          return;
        }
        if (key.backspace || key.delete || isBackspaceInput(value)) {
          hasLocalEditRef.current = true;
          replaceEditValue(editValueRef.current.slice(0, -1));
          return;
        }
        if (isPrintableInput(value) && !key.ctrl && !key.meta) {
          hasLocalEditRef.current = true;
          replaceEditValue(editValueRef.current + value);
        }
        return;
      }

      if (key.escape) {
        onClose();
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((current) => (current + 1) % CONNECT_FIELDS.length);
        return;
      }
      if (key.upArrow) {
        setSelectedIndex(
          (current) =>
            (current - 1 + CONNECT_FIELDS.length) % CONNECT_FIELDS.length,
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
        {CONNECT_FIELDS.map((field, index) => (
          <ConnectFieldRow
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
        <ConnectStatusLine isRunning={isRunning} saveState={saveState} />
      </Box>
    </Box>
  );
}

function ConnectFieldRow({
  draft,
  editValue,
  editingField,
  field,
  isSelected,
}: {
  readonly draft: ConnectDraft;
  readonly editValue: string;
  readonly editingField: ConnectFieldKey | null;
  readonly field: ConnectField;
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
      {field.optional ? <Text dimColor>optional </Text> : null}
      {displayValue}
    </Text>
  );
}

function ConnectStatusLine({
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
      return saveState.warning === undefined ? (
        <Text color={theme.status.success}>saved</Text>
      ) : (
        <Text color={theme.status.warning}>saved - {saveState.warning}</Text>
      );
    case "error":
      return <Text color={theme.status.error}>{saveState.message}</Text>;
    case "idle":
      return <Text> </Text>;
  }
}

function savedState(warning: string | undefined): SaveState {
  return warning === undefined
    ? { kind: "saved" }
    : { kind: "saved", warning };
}

function readConnectWarning(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }
  const warning = (result as Record<string, unknown>).warning;
  return typeof warning === "string" && warning.trim() !== ""
    ? warning
    : undefined;
}

type PayloadBuildResult =
  | { readonly kind: "incomplete" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly input: UiConnectModelInput };

function draftFromCurrentModel(current: UiCurrentModelConfig): ConnectDraft {
  return {
    apiKey: "",
    apiKeyEnv: current.apiKeyEnv,
    baseUrl: current.baseUrl,
    contextWindowTokens:
      current.contextWindowTokens === undefined
        ? ""
        : String(current.contextWindowTokens),
    maxOutputTokens:
      current.maxOutputTokens === undefined
        ? ""
        : String(current.maxOutputTokens),
    model: current.model,
    provider: current.provider,
  };
}

function buildPayload(draft: ConnectDraft): PayloadBuildResult {
  const provider = draft.provider.trim();
  const baseUrl = draft.baseUrl.trim();
  const interfaceProvider = inferInterfaceProvider(baseUrl);
  const apiKeyEnv = draft.apiKeyEnv.trim();
  const apiKey = draft.apiKey.trim();
  const model = draft.model.trim();

  if (!provider || !baseUrl || !apiKeyEnv || !model) {
    return { kind: "incomplete" };
  }

  const contextWindowTokens = parseOptionalPositiveInteger(
    draft.contextWindowTokens,
    "Context window",
  );
  if (contextWindowTokens.kind === "error") {
    return contextWindowTokens;
  }
  const maxOutputTokens = parseOptionalPositiveInteger(
    draft.maxOutputTokens,
    "Max output tokens",
  );
  if (maxOutputTokens.kind === "error") {
    return maxOutputTokens;
  }

  return {
    input: {
      apiKey: apiKey || undefined,
      apiKeyEnv,
      baseUrl,
      contextWindowTokens: contextWindowTokens.value,
      interfaceProvider,
      maxOutputTokens: maxOutputTokens.value,
      model,
      provider,
    },
    kind: "ready",
  };
}

function parseOptionalPositiveInteger(
  value: string,
  label: string,
):
  | { readonly kind: "ok"; readonly value?: number }
  | { readonly kind: "error"; readonly message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: "ok" };
  }
  if (!/^\d+$/u.test(trimmed)) {
    return { kind: "error", message: `${label} must be a positive integer` };
  }
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0
    ? { kind: "ok", value: parsed }
    : { kind: "error", message: `${label} must be a positive integer` };
}

function updateDraft(
  draft: ConnectDraft,
  field: ConnectFieldKey,
  value: string,
): ConnectDraft {
  const trimmedValue = value.trim();
  if (field === "baseUrl") {
    return {
      ...draft,
      baseUrl: trimmedValue,
    };
  }
  return {
    ...draft,
    [field]: trimmedValue,
  };
}

function inferInterfaceProvider(
  baseUrl: string,
): UiConnectModelInterfaceProvider {
  const lower = baseUrl.toLowerCase();
  return lower.includes("anthropic") ||
    lower.includes("/api/anthropic") ||
    lower.endsWith("/anthropic") ||
    lower.includes("/v1/messages")
    ? "anthropic"
    : "openai-compatible";
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
    error instanceof Error ? error.message : "Model connection failed";
  const withoutExactSecret =
    secret && secret.trim() !== ""
      ? message.split(secret).join("[redacted]")
      : message;
  return withoutExactSecret
    .replace(/https?:\/\/[^\s)]*/giu, "[redacted-url]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token)=)[^&\s)]+/giu,
      "$1[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[redacted]");
}
