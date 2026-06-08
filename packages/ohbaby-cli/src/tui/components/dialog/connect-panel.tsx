import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiConnectModelInput,
  UiConnectModelInterfaceProvider,
  UiRunStatus,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { useTheme } from "../../theme/index.js";

type ConnectSection = "connection" | "model";
type ConnectFieldKey =
  | "provider"
  | "baseUrl"
  | "interfaceProvider"
  | "apiKeyEnv"
  | "apiKey"
  | "model"
  | "contextWindowTokens"
  | "maxOutputTokens";

interface ConnectField {
  readonly key: ConnectFieldKey;
  readonly label: string;
  readonly secret?: boolean;
}

interface ConnectDraft {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: string;
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
  | { readonly kind: "saved" }
  | { readonly kind: "error"; readonly message: string };

const CONNECTION_FIELDS: readonly ConnectField[] = [
  { key: "provider", label: "Provider" },
  { key: "baseUrl", label: "Base URL" },
  { key: "interfaceProvider", label: "Interface" },
  { key: "apiKeyEnv", label: "API key env" },
  { key: "apiKey", label: "API key value", secret: true },
];

const MODEL_FIELDS: readonly ConnectField[] = [
  { key: "model", label: "Model name" },
  { key: "contextWindowTokens", label: "Context window" },
  { key: "maxOutputTokens", label: "Max output tokens" },
];

const EMPTY_DRAFT: ConnectDraft = {
  apiKey: "",
  apiKeyEnv: "",
  baseUrl: "",
  contextWindowTokens: "",
  interfaceProvider: "",
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
  const theme = useTheme();
  const [draft, setDraft] = useState<ConnectDraft>(EMPTY_DRAFT);
  const [section, setSection] = useState<ConnectSection>("connection");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingField, setEditingField] = useState<ConnectFieldKey | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const draftRef = useRef<ConnectDraft>(EMPTY_DRAFT);
  const editValueRef = useRef("");
  const lastSavedPayloadKeyRef = useRef<string | null>(null);
  const inFlightSaveKeyRef = useRef<string | null>(null);
  const latestSaveKeyRef = useRef<string | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);

  const fields = section === "connection" ? CONNECTION_FIELDS : MODEL_FIELDS;
  const selectedField = fields[Math.min(selectedIndex, fields.length - 1)];
  const isRunning = runtime.kind === "running";

  const replaceEditValue = (nextValue: string): void => {
    editValueRef.current = nextValue;
    setEditValue(nextValue);
  };

  const replaceDraft = (nextDraft: ConnectDraft): void => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  const startSave = (save: PendingSave): void => {
    inFlightSaveKeyRef.current = save.key;
    setSaveState({ kind: "saving" });
    void client
      .connectModel(save.input)
      .then(() => {
        lastSavedPayloadKeyRef.current = save.key;
        if (pendingSaveRef.current === null) {
          setSaveState(
            latestSaveKeyRef.current === save.key
              ? { kind: "saved" }
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
            setSaveState({ kind: "saved" });
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
      setSaveState({ kind: "saved" });
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
      if (editingField !== null) {
        if (key.escape) {
          setEditingField(null);
          replaceEditValue("");
          return;
        }
        if (isReturn) {
          const nextDraft = updateDraft(
            draftRef.current,
            editingField,
            editValueRef.current,
          );
          replaceDraft(nextDraft);
          setEditingField(null);
          replaceEditValue("");
          maybeSave(nextDraft);
          return;
        }
        if (key.backspace || key.delete || value === "\u007F") {
          replaceEditValue(editValueRef.current.slice(0, -1));
          return;
        }
        if (value !== "" && !key.ctrl && !key.meta) {
          replaceEditValue(editValueRef.current + value);
        }
        return;
      }

      if (key.escape) {
        onClose();
        return;
      }
      if (key.pageDown) {
        setSection("model");
        setSelectedIndex(0);
        return;
      }
      if (key.pageUp) {
        setSection("connection");
        setSelectedIndex(0);
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((current) => (current + 1) % fields.length);
        return;
      }
      if (key.upArrow) {
        setSelectedIndex(
          (current) => (current - 1 + fields.length) % fields.length,
        );
        return;
      }
      if (isReturn) {
        setEditingField(selectedField.key);
        replaceEditValue(draftRef.current[selectedField.key]);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={theme.status.accent}>
          {section === "connection" ? "Connection 1/2" : "Model 2/2"}
        </Text>
        <Text color={theme.text.muted}>pgup/pgdn</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((field, index) => (
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
  const label = field.label.padEnd(17, " ");

  return (
    <Text color={isSelected ? theme.text.strong : undefined}>
      {prefix}
      <Text bold>{label}</Text>
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
      return <Text color={theme.status.success}>saved</Text>;
    case "error":
      return <Text color={theme.status.error}>{saveState.message}</Text>;
    case "idle":
      return <Text> </Text>;
  }
}

type PayloadBuildResult =
  | { readonly kind: "incomplete" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly input: UiConnectModelInput };

function buildPayload(draft: ConnectDraft): PayloadBuildResult {
  const provider = draft.provider.trim();
  const baseUrl = draft.baseUrl.trim();
  const interfaceProvider = normalizeInterfaceProvider(
    draft.interfaceProvider,
  );
  const apiKeyEnv = draft.apiKeyEnv.trim();
  const apiKey = draft.apiKey.trim();
  const model = draft.model.trim();

  if (!provider || !baseUrl || !interfaceProvider || !apiKeyEnv || !model) {
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
    const inferredInterface =
      draft.interfaceProvider.trim() === ""
        ? inferInterfaceProvider(trimmedValue)
        : draft.interfaceProvider;
    return {
      ...draft,
      baseUrl: trimmedValue,
      interfaceProvider: inferredInterface,
    };
  }
  if (field === "interfaceProvider") {
    return {
      ...draft,
      interfaceProvider:
        normalizeInterfaceProvider(trimmedValue) ?? trimmedValue,
    };
  }
  return {
    ...draft,
    [field]: trimmedValue,
  };
}

function inferInterfaceProvider(
  baseUrl: string,
): UiConnectModelInterfaceProvider | "" {
  if (!baseUrl) {
    return "";
  }
  const lower = baseUrl.toLowerCase();
  return lower.includes("anthropic") || lower.includes("/v1/messages")
    ? "anthropic"
    : "openai-compatible";
}

function normalizeInterfaceProvider(
  value: string,
): UiConnectModelInterfaceProvider | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-compatible") {
    return "openai-compatible";
  }
  if (normalized === "anthropic") {
    return "anthropic";
  }
  return null;
}

function maskSecret(value: string): string {
  return value.length > 0 ? "********" : "";
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
