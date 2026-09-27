import type {
  UiBackendClient,
  UiConnectModelInterfaceProvider,
  UiConnectModelResult,
  UiCurrentModelConfig,
  UiProbeModelContextWindowResult,
} from "ohbaby-sdk";
import {
  connectUrlPathWarning,
  inferConnectModelInterfaceProvider,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatTokenCount } from "./GoalControl.js";
import {
  OverlayResult,
  type OverlayStatus,
  OverlayStatusLine,
  runOverlayAction,
  TextField,
} from "./overlay-controls.js";

interface ConnectModelFormState {
  readonly interfaceProvider?: UiConnectModelInterfaceProvider;
  readonly apiKey: string;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly contextWindowTokens: string;
  readonly maxOutputTokens: string;
  readonly model: string;
  readonly provider: string;
}

export function ConnectModelOverlayBody(props: {
  readonly client: UiBackendClient;
}): ReactElement {
  const [form, setForm] = useState<ConnectModelFormState>({
    apiKey: "",
    apiKeyEnv: "",
    baseUrl: "",
    contextWindowTokens: "",
    maxOutputTokens: "",
    model: "",
    provider: "",
  });
  const hasLocalEditRef = useRef(false);
  const requestVersion = useRef(0);
  const connectionGeneration = useRef(0);
  const savedVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      requestVersion.current++;
      connectionGeneration.current++;
    };
  }, [props.client]);
  const [currentModel, setCurrentModel] = useState<UiCurrentModelConfig | null>(
    null,
  );
  const [probe, setProbe] = useState<UiProbeModelContextWindowResult | null>(
    null,
  );
  const [result, setResult] = useState<UiConnectModelResult | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: "",
  });
  const urlPathWarning = connectUrlPathWarning(
    form.baseUrl,
    form.interfaceProvider ?? inferConnectModelInterfaceProvider(form.baseUrl),
    form.model,
  );

  useEffect(() => {
    let cancelled = false;
    const version = savedVersion.current;
    void props.client
      .getCurrentModel()
      .then((model) => {
        if (cancelled || savedVersion.current !== version) {
          return;
        }
        setCurrentModel(model);
        if (model && !hasLocalEditRef.current) {
          setForm({
            interfaceProvider: model.interfaceProvider,
            apiKey: "",
            apiKeyEnv: model.apiKeyEnv ?? "",
            baseUrl: model.baseUrl,
            contextWindowTokens:
              model.contextWindowTokens === undefined
                ? ""
                : String(model.contextWindowTokens),
            maxOutputTokens:
              model.maxOutputTokens === undefined
                ? ""
                : String(model.maxOutputTokens),
            model: model.model,
            provider: model.provider,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && savedVersion.current === version) {
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [props.client]);

  const update = useCallback(
    (key: keyof ConnectModelFormState, value: string) => {
      hasLocalEditRef.current = true;
      requestVersion.current++;
      setProbe(null);
      setForm((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const probeContext = useCallback(() => {
    const version = ++requestVersion.current;
    const current = (): boolean =>
      mounted.current && requestVersion.current === version;
    void runOverlayAction(
      (status) => {
        if (current()) setStatus(status);
      },
      async () => {
        const nextProbe = await props.client.probeModelContextWindow(
          connectModelRequest(form),
        );
        if (current()) setProbe(nextProbe);
        return `context window ${formatTokenCount(
          nextProbe.contextWindowTokens,
        )} · ${nextProbe.contextWindowSource}`;
      },
      "Probing model context",
    );
  }, [form, props.client]);

  const saveModel = useCallback(() => {
    const version = ++requestVersion.current;
    const connection = connectionGeneration.current;
    const current = (): boolean =>
      mounted.current && requestVersion.current === version;
    void runOverlayAction(
      (status) => {
        if (current()) setStatus(status);
      },
      async () => {
        const nextResult = await props.client.connectModel(
          connectModelRequest(form),
        );
        if (
          mounted.current &&
          connectionGeneration.current === connection &&
          version >= savedVersion.current
        ) {
          savedVersion.current = version;
          setCurrentModel(nextResult);
        }
        if (!current())
          return `saved ${nextResult.provider} · ${nextResult.model}`;
        setResult(nextResult);
        setForm((previous) => ({
          ...previous,
          apiKey: "",
          interfaceProvider:
            previous.interfaceProvider ?? nextResult.interfaceProvider,
        }));
        return `saved ${nextResult.provider} · ${nextResult.model}`;
      },
      "Saving model",
    );
  }, [form, props.client]);

  return (
    <div className="ohb-structured-body">
      <p>
        {currentModel
          ? `Current model: ${currentModel.provider} · ${currentModel.model}`
          : "Connect a model provider for browser runs."}
      </p>
      <div className="ohb-structured-grid">
        <TextField
          label="Provider"
          onChange={(value) => {
            update("provider", value);
          }}
          placeholder="Enter provider name"
          value={form.provider}
        />
        <TextField
          label="Model"
          onChange={(value) => {
            update("model", value);
          }}
          placeholder="Enter model identifier"
          value={form.model}
        />
        <TextField
          label="Base URL"
          onChange={(value) => {
            update("baseUrl", value);
          }}
          onBlur={() => {
            setForm((previous) =>
              previous.interfaceProvider !== undefined ||
              !previous.baseUrl.trim()
                ? previous
                : {
                    ...previous,
                    interfaceProvider: inferConnectModelInterfaceProvider(
                      previous.baseUrl,
                    ),
                  },
            );
          }}
          placeholder="Enter provider API base URL"
          value={form.baseUrl}
        />
        <label className="ohb-structured-field">
          <span>Protocol</span>
          <select
            aria-label="Protocol"
            value={
              form.interfaceProvider ??
              inferConnectModelInterfaceProvider(form.baseUrl)
            }
            onChange={(event) => {
              hasLocalEditRef.current = true;
              requestVersion.current++;
              setProbe(null);
              setForm((previous) => ({
                ...previous,
                interfaceProvider: event.target
                  .value as UiConnectModelInterfaceProvider,
              }));
            }}
          >
            <option value="openai-compatible">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </label>
        {urlPathWarning ? (
          <p role="status" className="ohb-structured-warning">
            {urlPathWarning}
          </p>
        ) : null}
        <TextField
          label="API key env"
          onChange={(value) => {
            update("apiKeyEnv", value);
          }}
          placeholder="Enter API key environment variable name"
          value={form.apiKeyEnv}
        />
        <TextField
          label="API key"
          onChange={(value) => {
            update("apiKey", value);
          }}
          placeholder="Optional; saved to .env when provided"
          type="password"
          value={form.apiKey}
        />
        <TextField
          label="Context window"
          onChange={(value) => {
            update("contextWindowTokens", value);
          }}
          placeholder="Optional; auto-detected when blank"
          value={form.contextWindowTokens}
        />
        <TextField
          label="Max output"
          onChange={(value) => {
            update("maxOutputTokens", value);
          }}
          placeholder="Optional; uses provider default when blank"
          value={form.maxOutputTokens}
        />
      </div>
      <OverlayStatusLine status={status} />
      {probe ? (
        <OverlayResult
          rows={[
            ["context", formatTokenCount(probe.contextWindowTokens)],
            ["source", probe.contextWindowSource],
            ...(probe.warning ? [["warning", probe.warning] as const] : []),
          ]}
        />
      ) : null}
      {result ? (
        <OverlayResult
          rows={[
            ["provider", result.provider],
            ["model", result.model],
            ["interface", result.interfaceProvider],
            ["context", formatTokenCount(result.contextWindowTokens)],
            ["source", result.contextWindowSource],
            ...(result.warning ? [["warning", result.warning] as const] : []),
          ]}
        />
      ) : null}
      <div className="ohb-structured-actions">
        <button
          className="ohb-button"
          onClick={probeContext}
          title="Probe context"
          type="button"
        >
          Probe context
        </button>
        <button
          className="ohb-button-primary"
          onClick={saveModel}
          title="Save model"
          type="button"
        >
          Save model
        </button>
      </div>
    </div>
  );
}

function connectModelRequest(
  form: ConnectModelFormState,
): Parameters<UiBackendClient["connectModel"]>[0] {
  const provider = requiredText(form.provider, "Provider");
  const baseUrl = requiredText(form.baseUrl, "Base URL");
  const apiKeyEnv = trimmedOrUndefined(form.apiKeyEnv);
  const model = requiredText(form.model, "Model");
  const apiKey = trimmedOrUndefined(form.apiKey);
  const contextWindowTokens = optionalIntegerValue(
    "contextWindowTokens",
    form.contextWindowTokens,
  );
  const maxOutputTokens = optionalIntegerValue(
    "maxOutputTokens",
    form.maxOutputTokens,
  );
  return {
    provider,
    baseUrl,
    interfaceProvider:
      form.interfaceProvider ?? inferConnectModelInterfaceProvider(baseUrl),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

export function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalIntegerValue(
  label: string,
  value: string,
): number | undefined {
  const trimmed = trimmedOrUndefined(value);
  if (trimmed === undefined) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

import type { UiSetSearchApiKeyResult } from "ohbaby-sdk";
import type { SearchApiKeyRequest } from "../../api/daemon/wire.js";

export function ConnectSearchOverlayBody(props: {
  readonly client: UiBackendClient;
}): ReactElement {
  const [apiKeyEnv, setApiKeyEnv] = useState("TAVILY_API_KEY");
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<UiSetSearchApiKeyResult | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: "",
  });

  const saveSearchKey = useCallback(() => {
    void runOverlayAction(
      setStatus,
      async () => {
        const input: SearchApiKeyRequest = {
          apiKeyEnv: trimmedOrUndefined(apiKeyEnv),
          apiKey: trimmedOrUndefined(apiKey),
          provider: "tavily",
        };
        const nextResult = await props.client.setSearchApiKey(input);
        setResult(nextResult);
        setApiKey("");
        return `saved ${nextResult.provider} key reference`;
      },
      "Saving search key",
    );
  }, [apiKey, apiKeyEnv, props.client]);

  return (
    <div className="ohb-structured-body">
      <p>Connect Tavily search for web-enabled workflows.</p>
      <div className="ohb-structured-grid">
        <TextField label="Provider" onChange={() => undefined} value="tavily" />
        <TextField
          label="API key env"
          onChange={setApiKeyEnv}
          placeholder="TAVILY_API_KEY"
          value={apiKeyEnv}
        />
        <TextField
          label="API key"
          onChange={setApiKey}
          placeholder="optional, writes to .env"
          type="password"
          value={apiKey}
        />
      </div>
      <OverlayStatusLine status={status} />
      {result ? (
        <OverlayResult
          rows={[
            ["provider", result.provider],
            ["env", result.apiKeyEnv],
            ["config", result.searchJsonPath],
          ]}
        />
      ) : null}
      <div className="ohb-structured-actions">
        <button
          className="ohb-button-primary"
          onClick={saveSearchKey}
          title="Save search key"
          type="button"
        >
          Save search key
        </button>
      </div>
    </div>
  );
}
