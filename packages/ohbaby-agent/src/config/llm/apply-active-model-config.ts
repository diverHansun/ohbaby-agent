import {
  readModelDocument,
  loadProjectedModelJson,
  configurationComplete,
} from "./model-document.js";
import {
  modelEntryGeneration,
  writeModelEntryMetadata,
  type ModelSettingsOptions,
} from "./writer.js";
import { capabilitiesFor } from "ohbaby-llm";
import { reasoningCapabilityView } from "../../services/llm-model/reasoning-view.js";
import type { UiReasoningCapabilityView } from "ohbaby-sdk";
import { modelProfileRouteKey, normalizedEndpoint } from "ohbaby-llm";
import {
  coordinateModelConfig,
  outsideModelConfigCoordination,
} from "./config-coordination.js";
import { getModelJsonPath } from "./loaders.js";
import { resolve } from "node:path";
import { runtimeEnvValue } from "../../utils/managed-runtime-env.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../services/llm-model/modelProfiles.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import type { InterfaceProviderKind, ReasoningConfig } from "ohbaby-llm";
import { ConfigError } from "ohbaby-llm";
import { validateReasoningConfig } from "ohbaby-llm";
import {
  probeContextWindow,
  type ContextWindowSource,
  type ProbeContextWindowResult,
} from "./context-window-probe.js";
import { probeReasoningCapabilities } from "./reasoning-active-probe.js";
import { loadEnvFile } from "./loaders.js";
import { reloadLLMConfig, setActiveLLMConfig } from "./index.js";
import {
  firstNonEmptyApiKey,
  nonEmptyApiKey,
  OPTIONAL_API_KEY_PLACEHOLDER,
} from "./api-key.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const INTERFACE_PROVIDER_KINDS = new Set<InterfaceProviderKind>([
  "openai-compatible",
  "openai-responses",
  "anthropic",
]);

interface ResolvedApiKey {
  readonly value: string;
  readonly warning?: string;
}

export interface ApplyActiveModelConfigInput {
  readonly reasoning?: ReasoningConfig;
  readonly deferMetadata?: boolean;
  readonly onDiscovery?: () => void | Promise<void>;
  readonly provider?: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly projectRoot: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
}

export interface ApplyActiveModelConfigResult {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly apiKeyEnv?: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly contextWindowSource: ContextWindowSource;
  readonly maxOutputTokens?: number;
  readonly modelJsonPath: string;
  readonly envPath: string;
  readonly saved: true;
  readonly warning?: string;
}

export interface ProbeActiveModelContextWindowInput {
  readonly modelJsonPath?: string;
  readonly projectRoot?: string;
  readonly onDiscovery?: () => void | Promise<void>;
  readonly provider?: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly envPath?: string;
}

export interface ProbeActiveModelContextWindowResult {
  readonly reasoning?: UiReasoningCapabilityView;
  readonly contextWindowTokens: number;
  readonly contextWindowSource: ContextWindowSource;
  readonly warning?: string;
}

export async function probeActiveModelContextWindow(
  input: ProbeActiveModelContextWindowInput,
): Promise<ProbeActiveModelContextWindowResult> {
  const model = requireNonEmpty(input.model, "Model name required");
  const baseUrl = validateBaseUrl(input.baseUrl);
  const apiKeyEnv = validateOptionalApiKeyEnv(input.apiKeyEnv);
  const interfaceProvider = validateInterfaceProvider(input.interfaceProvider);
  const contextWindowTokens = validateOptionalPositiveInteger(
    input.contextWindowTokens,
    "Context window must be a positive integer",
  );
  validateOptionalPositiveInteger(
    input.maxOutputTokens,
    "Max output tokens must be a positive integer",
  );
  const envPath = input.envPath ?? getGlobalEnvPath();

  const apiKey = await resolveApiKey({
    apiKey: input.apiKey,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    envPath,
  });
  let current;
  try {
    const raw = await loadProjectedModelJson({
      modelJsonPath: input.modelJsonPath,
    });
    current = raw;
  } catch {
    /* A draft can be probed before any model is saved. */
  }
  const currentKey = current
    ? await resolveApiKey({ apiKeyEnv: current.apiConfig.apiKeyEnv, envPath })
    : undefined;
  const matches =
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Explicit guard preserves narrowing across all route fields.
    current !== undefined &&
    (input.provider ?? current.provider) === current.provider &&
    current.defaultModel === model &&
    normalizedEndpoint(current.apiConfig.baseUrl) ===
      normalizedEndpoint(baseUrl) &&
    (current.apiConfig.interfaceProvider ?? "openai-compatible") ===
      interfaceProvider &&
    currentKey?.value === apiKey.value;
  const currentId = current?.models?.at(0)?.id;
  const probe =
    matches && current && currentId
      ? await startModelEntryDiscovery(currentId, {
          modelJsonPath: input.modelJsonPath,
          envPath,
          onDiscovery: input.onDiscovery,
          allowActiveProbe: true,
        })
      : await probeContextWindow({
          apiKey: apiKey.value,
          baseUrl,
          interfaceProvider,
          model,
        });
  const hasExplicitProfile =
    matches &&
    current &&
    capabilitiesFor({
      provider: current.provider,
      model,
      baseUrl,
      interfaceProvider,
      maxTokens: current.llmParams.maxTokens,
      modelProfiles: current.models,
    }).source === "local-model-profile";
  const reasoning = reasoningCapabilityView(
    {
      provider: input.provider ?? current?.provider ?? "custom",
      baseUrl,
      model,
      interfaceProvider,
      maxTokens:
        input.maxOutputTokens ??
        current?.llmParams.maxTokens ??
        DEFAULT_MAX_OUTPUT_TOKENS,
      modelProfiles: hasExplicitProfile
        ? current?.models
        : probe.reasoningCapabilities
          ? [
              {
                model,
                contextWindowTokens:
                  probe.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
                reasoningCapabilities: probe.reasoningCapabilities,
                reasoningCapabilitySource: "model-metadata",
              },
            ]
          : matches && current
            ? current.models
            : undefined,
    },
    {
      status: probe.reasoningReason
        ? "unknown"
        : probe.reasoningCapabilities
          ? "identified"
          : "unknown",
      reason: probe.reasoningReason,
    },
  );

  return {
    ...withWarning(
      resolveContextWindow({
        detectedContextWindowTokens: probe.contextWindowTokens,
        probeWarning: probe.warning,
        userContextWindowTokens: contextWindowTokens,
      }),
      apiKey.warning,
    ),
    reasoning,
  };
}

function withWarning<T extends { readonly warning?: string }>(
  result: T,
  warning: string | undefined,
): T {
  const combinedWarning = combineWarnings(warning, result.warning);
  return combinedWarning === undefined
    ? result
    : { ...result, warning: combinedWarning };
}

function combineWarnings(
  ...warnings: readonly (string | undefined)[]
): string | undefined {
  const parts = warnings.filter(
    (warning): warning is string => warning !== undefined && warning !== "",
  );
  return parts.length === 0 ? undefined : parts.join(" ");
}

function missingApiKeyEnvWarning(apiKeyEnv: string): string {
  return `API key env ${apiKeyEnv} is configured but no value was found; using a placeholder so the upstream endpoint can decide whether authentication is required.`;
}

export async function applyActiveModelConfig(
  input: ApplyActiveModelConfigInput,
): Promise<ApplyActiveModelConfigResult> {
  validateReasoningConfig(input.reasoning);
  const provider = requireNonEmpty(input.provider, "Provider required");
  const model = requireNonEmpty(input.model, "Model name required");
  const baseUrl = validateBaseUrl(input.baseUrl);
  const providedApiKeyEnv = validateOptionalApiKeyEnv(input.apiKeyEnv);
  const apiKeyEnv = providedApiKeyEnv;
  const interfaceProvider = validateInterfaceProvider(input.interfaceProvider);
  const contextWindowTokens = validateOptionalPositiveInteger(
    input.contextWindowTokens,
    "Context window must be a positive integer",
  );
  const maxOutputTokens = validateOptionalPositiveInteger(
    input.maxOutputTokens,
    "Max output tokens must be a positive integer",
  );
  const envPath = input.envPath ?? getGlobalEnvPath();

  const apiKey = await resolveApiKey({
    apiKey: input.apiKey,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    envPath,
  });
  const probe = input.deferMetadata
    ? {}
    : await probeContextWindow({
        apiKey: apiKey.value,
        baseUrl,
        interfaceProvider,
        model,
      });
  const resolvedContextWindow = withWarning(
    resolveContextWindow({
      detectedContextWindowTokens: probe.contextWindowTokens,
      probeWarning: probe.warning,
      userContextWindowTokens: contextWindowTokens,
    }),
    apiKey.warning,
  );

  const writeResult = await setActiveLLMConfig({
    provider,
    model,
    baseUrl,
    interfaceProvider,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    contextWindowTokens: resolvedContextWindow.contextWindowTokens,
    ...(maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens,
          maxTokens: maxOutputTokens,
        }),
    updateActiveModelProfile: true,
    clearTemperature: true,
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    ...(input.modelJsonPath === undefined
      ? {}
      : { modelJsonPath: input.modelJsonPath }),
    envPath,
  });

  if (input.deferMetadata) {
    void startModelEntryDiscovery(writeResult.profileId, {
      modelJsonPath: writeResult.modelJsonPath,
      envPath,
      onDiscovery: input.onDiscovery,
      allowActiveProbe: true,
    });
  }

  let reloadWarning: string | undefined;
  try {
    await reloadLLMConfig({
      envPath,
      modelJsonPath: writeResult.modelJsonPath,
      projectDirectory: input.projectRoot,
    });
  } catch {
    reloadWarning =
      "Configuration saved, but reload failed; it is temporarily unavailable for new runs.";
  }

  const warning = combineWarnings(resolvedContextWindow.warning, reloadWarning);
  return {
    provider,
    baseUrl,
    interfaceProvider,
    ...(writeResult.apiKeyEnv === undefined
      ? {}
      : { apiKeyEnv: writeResult.apiKeyEnv }),
    model,
    contextWindowTokens: resolvedContextWindow.contextWindowTokens,
    contextWindowSource: resolvedContextWindow.contextWindowSource,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    modelJsonPath: writeResult.modelJsonPath,
    envPath,
    saved: true,
    ...(warning === undefined ? {} : { warning }),
  };
}

function resolveContextWindow(input: {
  readonly detectedContextWindowTokens?: number;
  readonly probeWarning?: string;
  readonly userContextWindowTokens?: number;
}): {
  readonly contextWindowTokens: number;
  readonly contextWindowSource: ContextWindowSource;
  readonly warning?: string;
} {
  if (input.detectedContextWindowTokens !== undefined) {
    return {
      contextWindowSource: "detected",
      contextWindowTokens: input.detectedContextWindowTokens,
    };
  }
  if (input.userContextWindowTokens !== undefined) {
    return {
      contextWindowSource: "user",
      contextWindowTokens: input.userContextWindowTokens,
      ...(input.probeWarning === undefined
        ? {}
        : { warning: input.probeWarning }),
    };
  }
  return {
    contextWindowSource: "default",
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    ...(input.probeWarning === undefined
      ? {}
      : { warning: input.probeWarning }),
  };
}

function requireNonEmpty(value: string | undefined, message: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    throw new ConfigError(message, "INVALID_FIELD");
  }
  return trimmed;
}

function validateBaseUrl(value: string): string {
  const trimmed = requireNonEmpty(value, "Invalid base URL");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ConfigError("Invalid base URL", "INVALID_FIELD", {
      baseUrl: value,
    });
  }
  return normalizedEndpoint(trimmed);
}

function validateApiKeyEnv(value: string): string {
  const trimmed = requireNonEmpty(value, "Invalid API key env");
  if (!ENV_VAR_NAME_PATTERN.test(trimmed)) {
    throw new ConfigError("Invalid API key env", "INVALID_FIELD", {
      apiKeyEnv: value,
    });
  }
  return trimmed;
}

function validateOptionalApiKeyEnv(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return validateApiKeyEnv(value);
}

function validateInterfaceProvider(
  value: InterfaceProviderKind,
): InterfaceProviderKind {
  if (!INTERFACE_PROVIDER_KINDS.has(value)) {
    throw new ConfigError("Invalid interface provider", "INVALID_FIELD", {
      interfaceProvider: value,
    });
  }
  return value;
}

function validateOptionalPositiveInteger(
  value: number | undefined,
  message: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(message, "INVALID_MAX_TOKENS", { value });
  }
  return value;
}

async function resolveApiKey(input: {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly envPath: string;
}): Promise<ResolvedApiKey> {
  const explicitApiKey = nonEmptyApiKey(input.apiKey);
  if (explicitApiKey !== undefined) {
    return { value: explicitApiKey };
  }
  if (input.apiKeyEnv === undefined) {
    return { value: OPTIONAL_API_KEY_PLACEHOLDER };
  }
  const envFile: Partial<Record<string, string>> = await loadEnvFile(
    input.envPath,
  );
  const existing = firstNonEmptyApiKey(
    runtimeEnvValue(input.apiKeyEnv, process.env),
    envFile[input.apiKeyEnv],
  );
  if (existing === undefined) {
    return {
      value: OPTIONAL_API_KEY_PLACEHOLDER,
      warning: missingApiKeyEnvWarning(input.apiKeyEnv),
    };
  }
  return { value: existing };
}

interface ActiveDiscovery {
  readonly controller: AbortController;
  readonly generation: number;
  status: "detecting" | "identified" | "unknown";
  reason?: string;
}
const activeDiscoveries = new Map<string, ActiveDiscovery>();
function discoveryKey(id: string, options: ModelSettingsOptions): string {
  return `${resolve(options.modelJsonPath ?? getModelJsonPath())}\0${id}`;
}
export async function currentDiscoveryState(
  modelPath?: string,
  _envPath?: string,
  entryId?: string,
): Promise<
  | { status: "detecting" | "identified" | "unknown"; reason?: string }
  | undefined
> {
  const document = await readModelDocument({ modelJsonPath: modelPath });
  const id = entryId ?? document.activeProfileId;
  if (!id) return undefined;
  const options = { modelJsonPath: modelPath };
  const state = activeDiscoveries.get(discoveryKey(id, options));
  return state?.generation === modelEntryGeneration(id, options)
    ? {
        status: state.status,
        ...(state.reason ? { reason: state.reason } : {}),
      }
    : undefined;
}
/** Same scheduler for global candidate saves and the legacy active-model adapter. */
export async function startModelEntryDiscovery(
  id: string,
  options: ModelSettingsOptions & { allowActiveProbe?: boolean } = {},
): Promise<ProbeContextWindowResult> {
  const snapshot = await coordinateModelConfig(
    options.modelJsonPath,
    async () => {
      const document = await readModelDocument(options);
      const entry = document.models.find((e) => e.id === id);
      if (!entry || !configurationComplete(entry)) return undefined;
      const credential = await resolveApiKey({
        apiKeyEnv: entry.apiKeyEnv,
        envPath: options.envPath ?? getGlobalEnvPath(),
      });
      const key = discoveryKey(id, options);
      activeDiscoveries.get(key)?.controller.abort();
      const state: ActiveDiscovery = {
        controller: new AbortController(),
        generation: modelEntryGeneration(id, options),
        status: "detecting",
      };
      activeDiscoveries.set(key, state);
      return {
        entry,
        key,
        state,
        apiKey: credential.value,
        maxTokens: entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        routeKey: modelProfileRouteKey(entry, entry.provider),
      };
    },
  ).catch(() => null);
  // Background discovery must not reject after the foreground save succeeded.
  if (snapshot === null) return { reasoningReason: "network-error" };
  if (!snapshot) return {};
  const { entry, key, state, apiKey, maxTokens, routeKey } = snapshot;
  const isCurrent = (): boolean =>
    activeDiscoveries.get(key) === state && !state.controller.signal.aborted;
  return new Promise((resolveResult) =>
    outsideModelConfigCoordination(() =>
      setTimeout(() => {
        void (async (): Promise<ProbeContextWindowResult> => {
          if (!isCurrent()) return { reasoningReason: "cancelled" };
          const input = {
            provider: entry.provider,
            model: entry.model,
            baseUrl: entry.baseUrl,
            interfaceProvider: entry.interfaceProvider,
            apiKey,
            signal: state.controller.signal,
          };
          const metadata = await probeContextWindow(input);
          const explicit =
            entry.reasoningCapabilities &&
            entry.reasoningCapabilitySource !== "model-metadata" &&
            entry.reasoningCapabilitySource !== "active-probe"
              ? entry.reasoningCapabilities
              : undefined;
          const known = capabilitiesFor({
            ...input,
            maxTokens,
            modelProfiles: explicit ? [entry] : [],
          }).capability;
          const active =
            options.allowActiveProbe &&
            !known &&
            !metadata.reasoningCapabilities &&
            isCurrent()
              ? await probeReasoningCapabilities(input)
              : undefined;
          const probe = {
            ...metadata,
            reasoningReason:
              known || active ? undefined : metadata.reasoningReason,
            reasoningCapabilities:
              explicit ??
              (known ? undefined : (metadata.reasoningCapabilities ?? active)),
          };
          if (!isCurrent()) return probe;
          let wrote = false;
          if (
            probe.contextWindowTokens !== undefined ||
            probe.reasoningCapabilities
          )
            wrote = await writeModelEntryMetadata(
              id,
              {
                generation: state.generation,
                routeKey,
                contextWindowTokens: entry.contextWindowTokens,
              },
              {
                contextWindowTokens: probe.contextWindowTokens,
                reasoningCapabilities: probe.reasoningCapabilities,
                reasoningCapabilitySource: active
                  ? "active-probe"
                  : "model-metadata",
              },
              options,
            );
          if (modelEntryGeneration(id, options) !== state.generation)
            return probe;
          state.status = probe.reasoningReason
            ? "unknown"
            : probe.reasoningCapabilities || known
              ? "identified"
              : "unknown";
          state.reason = probe.reasoningReason;
          if (wrote || options.allowActiveProbe) await options.onDiscovery?.();
          return probe;
        })().then(resolveResult, () => {
          if (activeDiscoveries.get(key) === state) {
            state.status = "unknown";
            state.reason = "discovery-failed";
          }
          resolveResult({ reasoningReason: "network-error" });
        });
      }, 0),
    ),
  );
}
