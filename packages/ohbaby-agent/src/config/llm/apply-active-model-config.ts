import {
  reasoningCapabilityView,
  capabilitiesFor,
} from "../../services/interface-providers/reasoning.js";
import type { UiReasoningCapabilityView } from "ohbaby-sdk";
import { modelProfileRouteKey, normalizedEndpoint } from "./model-profile.js";
import {
  coordinateModelConfig,
  modelConfigVersion,
  outsideModelConfigCoordination,
} from "./config-coordination.js";
import { getModelJsonPath } from "./loaders.js";
import { resolve } from "node:path";
import { runtimeEnvValue } from "../../utils/managed-runtime-env.js";
import { createModelProfileRegistry } from "../../services/llm-model/modelProfiles.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import type { InterfaceProviderKind, ReasoningConfig } from "./types.js";
import { ConfigError } from "./types.js";
import { validateReasoningConfig, validateModelJson } from "./validation.js";
import {
  probeContextWindow,
  type ContextWindowSource,
  type ProbeContextWindowResult,
} from "./context-window-probe.js";
import { probeReasoningCapabilities } from "./reasoning-active-probe.js";
import { loadEnvFile, loadModelJson } from "./loaders.js";
import { reloadLLMConfig, setActiveLLMConfig } from "./index.js";
import {
  defaultApiKeyEnvForProvider,
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
  const modelJsonPath = input.modelJsonPath ?? getModelJsonPath();
  let current;
  try {
    const raw = await loadModelJson({ modelJsonPath });
    validateModelJson(raw);
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
  const probe =
    matches && current
      ? await startModelDiscovery({
          provider: current.provider,
          model,
          baseUrl,
          interfaceProvider,
          apiKey: apiKey.value,
          apiKeyEnv: current.apiConfig.apiKeyEnv,
          modelJsonPath,
          envPath,
          projectRoot: input.projectRoot ?? process.cwd(),
          contextWindowTokens:
            current.llmParams.contextWindowTokens ??
            DEFAULT_CONTEXT_WINDOW_TOKENS,
          maxOutputTokens: current.llmParams.maxTokens,
          version: await modelConfigVersion(modelJsonPath, envPath),
          onDiscovery: input.onDiscovery,
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
      maxTokens: input.maxOutputTokens ?? current?.llmParams.maxTokens ?? 4096,
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
  const explicitApiKey = nonEmptyApiKey(input.apiKey);
  const providedApiKeyEnv = validateOptionalApiKeyEnv(input.apiKeyEnv);
  const apiKeyEnv =
    providedApiKeyEnv ??
    (explicitApiKey === undefined
      ? undefined
      : defaultApiKeyEnvForProvider(provider));
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

  const profile = createModelProfileRegistry({
    defaultProvider: provider,
  }).resolve(model, provider);
  const resolvedMaxOutputTokens =
    maxOutputTokens ??
    (profile.source === "fallback" ? undefined : profile.maxOutputTokens);

  const writeResult = await setActiveLLMConfig({
    provider,
    model,
    baseUrl,
    interfaceProvider,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(explicitApiKey === undefined ? {} : { apiKey: explicitApiKey }),
    contextWindowTokens: resolvedContextWindow.contextWindowTokens,
    ...(resolvedMaxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: resolvedMaxOutputTokens,
          maxTokens: resolvedMaxOutputTokens,
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
    const version = await modelConfigVersion(
      writeResult.modelJsonPath,
      envPath,
    );
    void startModelDiscovery({
      provider,
      model,
      baseUrl,
      interfaceProvider,
      apiKey: apiKey.value,
      apiKeyEnv,
      modelJsonPath: writeResult.modelJsonPath,
      envPath,
      projectRoot: input.projectRoot,
      contextWindowTokens: resolvedContextWindow.contextWindowTokens,
      maxOutputTokens: resolvedMaxOutputTokens,
      version,
      onDiscovery: input.onDiscovery,
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
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    model,
    contextWindowTokens: resolvedContextWindow.contextWindowTokens,
    contextWindowSource: resolvedContextWindow.contextWindowSource,
    ...(resolvedMaxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: resolvedMaxOutputTokens }),
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
  return trimmed.replace(/\/+$/u, "");
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
  version: string;
  status: "detecting" | "identified" | "unknown";
  reason?: string;
}
const activeDiscoveries = new Map<string, ActiveDiscovery>();
export async function currentDiscoveryState(
  modelPath = getModelJsonPath(),
  envPath = getGlobalEnvPath(),
): Promise<
  | { status: "detecting" | "identified" | "unknown"; reason?: string }
  | undefined
> {
  const state = activeDiscoveries.get(resolve(modelPath));
  return state?.version === (await modelConfigVersion(modelPath, envPath))
    ? {
        status: state.status,
        ...(state.reason ? { reason: state.reason } : {}),
      }
    : undefined;
}
function startModelDiscovery(input: {
  provider: string;
  model: string;
  baseUrl: string;
  interfaceProvider: InterfaceProviderKind;
  apiKey: string;
  apiKeyEnv?: string;
  modelJsonPath: string;
  envPath: string;
  projectRoot: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  version: string;
  onDiscovery?: () => void | Promise<void>;
}): Promise<ProbeContextWindowResult> {
  const key = resolve(input.modelJsonPath);
  activeDiscoveries.get(key)?.controller.abort();
  const state: ActiveDiscovery = {
    controller: new AbortController(),
    version: input.version,
    status: "detecting",
  };
  activeDiscoveries.set(key, state);
  // Start after the saving turn: never inherit a live publication lock into network work.
  return new Promise((resolveResult) =>
    outsideModelConfigCoordination(() =>
      setTimeout(() => {
        void (async (): Promise<ProbeContextWindowResult> => {
          const metadata = await probeContextWindow({
            ...input,
            signal: state.controller.signal,
          });
          const savedModel = await loadModelJson({
            modelJsonPath: input.modelJsonPath,
          });
          validateModelJson(savedModel);
          const routeKey = modelProfileRouteKey(input, input.provider);
          const exactProfiles = savedModel.models?.filter(
            (profile) =>
              modelProfileRouteKey(profile, savedModel.provider) === routeKey,
          );
          const savedCapabilities =
            exactProfiles?.at(-1)?.reasoningCapabilities;
          const known = capabilitiesFor({
            provider: input.provider,
            model: input.model,
            baseUrl: input.baseUrl,
            interfaceProvider: input.interfaceProvider,
            maxTokens: input.maxOutputTokens ?? 4096,
            modelProfiles: exactProfiles,
          }).capability;
          const activeCapabilities =
            savedCapabilities ||
            metadata.reasoningCapabilities ||
            known ||
            state.controller.signal.aborted
              ? undefined
              : await probeReasoningCapabilities({
                  ...input,
                  signal: state.controller.signal,
                });
          const probe = {
            ...metadata,
            reasoningCapabilities:
              savedCapabilities ??
              metadata.reasoningCapabilities ??
              activeCapabilities,
          };
          await coordinateModelConfig(input.modelJsonPath, async () => {
            if (
              activeDiscoveries.get(key) !== state ||
              state.controller.signal.aborted ||
              (await modelConfigVersion(input.modelJsonPath, input.envPath)) !==
                input.version
            )
              return;
            if (probe.reasoningCapabilities || probe.contextWindowTokens) {
              await setActiveLLMConfig({
                provider: input.provider,
                model: input.model,
                baseUrl: input.baseUrl,
                interfaceProvider: input.interfaceProvider,
                apiKeyEnv: input.apiKeyEnv,
                modelJsonPath: input.modelJsonPath,
                envPath: input.envPath,
                contextWindowTokens:
                  probe.contextWindowTokens ?? input.contextWindowTokens,
                maxOutputTokens: input.maxOutputTokens,
                updateActiveModelProfile: true,
                discoveredReasoningCapabilities: savedCapabilities
                  ? undefined
                  : probe.reasoningCapabilities,
                ...(activeCapabilities
                  ? {
                      discoveredReasoningCapabilitySource:
                        "active-probe" as const,
                    }
                  : {}),
              });
              state.version = await modelConfigVersion(
                input.modelJsonPath,
                input.envPath,
              );
              await reloadLLMConfig({
                modelJsonPath: input.modelJsonPath,
                envPath: input.envPath,
                projectDirectory: input.projectRoot,
              });
            }
            state.status = probe.reasoningReason
              ? "unknown"
              : probe.reasoningCapabilities || known
                ? "identified"
                : "unknown";
            state.reason = probe.reasoningReason;
          });
          if (
            activeDiscoveries.get(key) === state &&
            !state.controller.signal.aborted
          )
            await input.onDiscovery?.();
          return probe;
        })().then(resolveResult, async () => {
          if (activeDiscoveries.get(key) === state) {
            state.status = "unknown";
            state.reason = "discovery-failed";
            try {
              await input.onDiscovery?.();
            } catch {
              /* View refresh failure must not create an unhandled rejection. */
            }
          }
          resolveResult({ reasoningReason: "network-error" });
        });
      }, 0),
    ),
  );
}
