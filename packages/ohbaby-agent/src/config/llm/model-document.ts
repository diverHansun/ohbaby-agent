import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  inferConnectModelInterfaceProvider,
  type UiModelSettingsNumericView,
} from "ohbaby-sdk";
import {
  activeModelBudgetProfiles,
  capabilitiesFor,
  rawCapabilitiesFor,
  resolveRequestReasoning,
  ConfigError,
  modelProfileRouteKey,
  hasUnsupportedAnthropicEffortPreference,
  validateModelJson,
  type ReasoningConfig,
  type ResolveRequestReasoningOptions,
  type InterfaceProviderKind,
  type ModelJsonConfig,
  type ModelJsonModelProfile,
  type PromptCachePolicy,
} from "ohbaby-llm";
import { loadModelJson, getModelJsonPath } from "./loaders.js";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  calculateTokenBudget,
} from "../../services/llm-model/modelProfiles.js";
const LEGACY_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface ModelEntry extends Omit<
  ModelJsonModelProfile,
  "contextWindowTokens"
> {
  id: string;
  provider: string;
  contextWindowTokens?: number;
  detectedContextWindowTokens?: number;
  detectedRouteKey?: string;
  apiKeyEnv?: string;
  promptCache?: PromptCachePolicy;
  needsConfiguration?: boolean;
  reasoning?: ReasoningConfig;
  temperature?: number;
}
export interface ModelDocument {
  schemaVersion?: 2;
  activeProfileId?: string;
  models: ModelEntry[];
}
export type ReasoningNotice = "unsupported-anthropic-effort-cleared";
const reasoningNotices = new Map<string, ReasoningNotice>();
function noticeKey(id: string, modelJsonPath?: string): string {
  return `${resolve(modelJsonPath ?? getModelJsonPath())}\0${id}`;
}
export function modelReasoningNotice(
  id: string,
  modelJsonPath?: string,
): ReasoningNotice | undefined {
  return reasoningNotices.get(noticeKey(id, modelJsonPath));
}
export function clearModelReasoningNotice(
  id: string,
  modelJsonPath?: string,
): void {
  reasoningNotices.delete(noticeKey(id, modelJsonPath));
}
export function clearUnsupportedAnthropicEffortPreference(
  entry: ModelEntry,
  modelJsonPath?: string,
): void {
  if (
    entry.reasoning &&
    hasUnsupportedAnthropicEffortPreference(entryReasoningOptions(entry))
  ) {
    delete entry.reasoning;
    reasoningNotices.set(
      noticeKey(entry.id, modelJsonPath),
      "unsupported-anthropic-effort-cleared",
    );
  }
}
export function configurationComplete(
  entry: ModelEntry,
): entry is ModelEntry & {
  baseUrl: string;
  interfaceProvider: InterfaceProviderKind;
} {
  return (
    !entry.needsConfiguration &&
    Boolean(entry.baseUrl && entry.interfaceProvider)
  );
}
export function hasCurrentDetection(entry: ModelEntry): boolean {
  return entry.detectedRouteKey === modelProfileRouteKey(entry, entry.provider);
}
export function resolveEntryTokenLimits(
  entry: ModelEntry,
): Pick<
  UiModelSettingsNumericView,
  | "effectiveContextWindowTokens"
  | "effectiveMaxOutputTokens"
  | "tokenBudgetIssue"
> {
  const contextWindowTokens =
    entry.contextWindowTokens ??
    (hasCurrentDetection(entry)
      ? entry.detectedContextWindowTokens
      : undefined) ??
    DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const budget = calculateTokenBudget({
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    contextWindowTokens,
    maxOutputTokens,
    source: "user",
  });
  return {
    effectiveContextWindowTokens: contextWindowTokens,
    effectiveMaxOutputTokens: maxOutputTokens,
    ...(budget.inputBudgetTokens > 0
      ? {}
      : {
          tokenBudgetIssue: {
            code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE" as const,
            contextWindowTokens,
            maxOutputTokens,
          },
        }),
  };
}
export function modelEntryNumericView(
  entry: ModelEntry,
  modelJsonPath?: string,
  contextDiscovery?: {
    status: "detecting" | "identified" | "unknown";
    reason?: string;
  },
): UiModelSettingsNumericView {
  const detected = hasCurrentDetection(entry)
    ? entry.detectedContextWindowTokens
    : undefined;
  const notice = modelReasoningNotice(entry.id, modelJsonPath);
  return {
    ...(entry.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: entry.contextWindowTokens }),
    ...(entry.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: entry.maxOutputTokens }),
    ...(detected === undefined
      ? {}
      : { detectedContextWindowTokens: detected }),
    ...resolveEntryTokenLimits(entry),
    contextDiscovery: contextDiscovery ?? {
      status:
        detected === undefined ? ("unknown" as const) : ("identified" as const),
    },
    ...(notice === undefined ? {} : { reasoningNotice: notice }),
  };
}
/** Storage-only provenance never reaches the LLM; every consumer shares this projection. */
export function projectModelEntry(
  entry: ModelEntry,
): ModelJsonModelProfile & { maxOutputTokens: number } {
  const {
    apiKeyEnv: _key,
    promptCache: _cache,
    needsConfiguration: _needs,
    detectedContextWindowTokens: _detected,
    detectedRouteKey: _route,
    reasoning: _reasoning,
    temperature: _temperature,
    ...profile
  } = entry;
  if (
    !hasCurrentDetection(entry) &&
    (profile.reasoningCapabilitySource === "model-metadata" ||
      profile.reasoningCapabilitySource === "active-probe")
  ) {
    delete profile.reasoningCapabilities;
    delete profile.reasoningCapabilitySource;
  }
  const limits = resolveEntryTokenLimits(entry);
  return {
    ...profile,
    contextWindowTokens: limits.effectiveContextWindowTokens,
    maxOutputTokens: limits.effectiveMaxOutputTokens,
  };
}
export function entryReasoningOptions(
  entry: ModelEntry,
): ResolveRequestReasoningOptions {
  return {
    ...entry,
    baseUrl: entry.baseUrl ?? "",
    interfaceProvider:
      entry.interfaceProvider ?? ("openai-compatible" as const),
    maxTokens: resolveEntryTokenLimits(entry).effectiveMaxOutputTokens,
    modelProfiles: [projectModelEntry(entry)],
  };
}
export function projectModelDocument(
  document: ModelDocument,
  entryId?: string,
): ModelJsonConfig | null {
  const active = document.models.find(
    (entry) => entry.id === (entryId ?? document.activeProfileId),
  );
  if (!active || !configurationComplete(active)) return null;
  const profile = projectModelEntry(active);
  const projected = {
    provider: active.provider,
    defaultModel: active.model,
    apiConfig: {
      baseUrl: active.baseUrl,
      interfaceProvider: active.interfaceProvider,
      ...(active.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: active.apiKeyEnv }),
      ...(active.promptCache === undefined
        ? {}
        : { promptCache: active.promptCache }),
    },
    llmParams: {
      maxTokens: profile.maxOutputTokens,
      contextWindowTokens: profile.contextWindowTokens,
      ...(active.temperature === undefined
        ? {}
        : { temperature: active.temperature }),
      ...(active.reasoning === undefined
        ? {}
        : { reasoning: active.reasoning }),
    },
    models: [profile],
  };
  validateModelJson(projected);
  return projected;
}
function sourceRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ConfigError("Invalid model document", "INVALID_FIELD");
  return structuredClone(raw) as Record<string, unknown>;
}
function entriesFrom(source: Record<string, unknown>): ModelEntry[] {
  if (source.models !== undefined && !Array.isArray(source.models))
    throw new ConfigError("Invalid models", "INVALID_FIELD");
  const profiles = ((source.models ?? []) as unknown[]).map(sourceRecord);
  const reserved = new Set(profiles.map((profile) => profile.id));
  const used = new Set<string>();
  return profiles.map((profile, index) => {
    let id = typeof profile.id === "string" ? profile.id : "";
    if (!id.trim() || used.has(id)) {
      id = `profile-${createHash("sha256")
        .update(
          JSON.stringify([
            index,
            profile.provider,
            profile.model,
            profile.baseUrl,
            profile.interfaceProvider,
          ]),
        )
        .digest("hex")
        .slice(0, 16)}`;
      while (reserved.has(id) || used.has(id)) id += "-m";
    }
    used.add(id);
    return {
      ...profile,
      id,
      provider: profile.provider ?? source.provider ?? "custom",
    } as ModelEntry;
  });
}
/** Pure validation/normalization of current intent, never historical numeric migration. */
export function normalizeModelDocument(raw: unknown): ModelDocument {
  const source = sourceRecord(raw);
  if (Object.hasOwn(source, "schemaVersion") && source.schemaVersion !== 2)
    throw new ConfigError(
      "Unsupported model document version",
      "INVALID_FIELD",
    );
  if (
    source.activeProfileId !== undefined &&
    (typeof source.activeProfileId !== "string" ||
      !source.activeProfileId.trim())
  )
    throw new ConfigError("Invalid active model id", "INVALID_FIELD");
  const models = entriesFrom(source);
  for (const entry of models) validateEntry(entry);
  const document: ModelDocument = {
    schemaVersion: 2,
    ...(source.activeProfileId === undefined
      ? {}
      : { activeProfileId: source.activeProfileId }),
    models,
  };
  projectModelDocument(document);
  return document;
}
/** Expand legacy shape without validating preferences against its obsolete output budget. */
function migrateModelDocument(raw: unknown): ModelDocument {
  const source = sourceRecord(raw);
  if (Object.hasOwn(source, "schemaVersion"))
    return normalizeModelDocument(source);
  const models = entriesFrom(source);
  const legacy =
    !Object.hasOwn(source, "activeProfileId") &&
    source.provider !== undefined &&
    source.defaultModel !== undefined &&
    source.apiConfig !== undefined;
  if (!Object.hasOwn(source, "activeProfileId") && source.models === undefined)
    validateModelJson(source);
  let activeProfileId = source.activeProfileId as string | undefined;
  const params = source.llmParams as
    | Partial<ModelJsonConfig["llmParams"]>
    | undefined;
  if (params !== undefined)
    validateModelJson({
      provider: "document-validation",
      defaultModel: "document-validation",
      apiConfig: { baseUrl: "http://localhost" },
      llmParams: {
        ...params,
        maxTokens: params.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
    });
  if (legacy) {
    const api = source.apiConfig as
      | Partial<ModelJsonConfig["apiConfig"]>
      | null
      | undefined;
    if (
      !api ||
      typeof api !== "object" ||
      typeof api.baseUrl !== "string" ||
      typeof source.provider !== "string" ||
      typeof source.defaultModel !== "string"
    )
      throw new ConfigError(
        "Incomplete legacy model document",
        "MISSING_FIELD",
      );
    const provider = source.provider,
      model = source.defaultModel;
    const interfaceProvider =
      api.interfaceProvider ?? inferConnectModelInterfaceProvider(api.baseUrl);
    for (const entry of models)
      if (!entry.apiKeyEnv || !entry.baseUrl || !entry.interfaceProvider)
        entry.needsConfiguration = true;
    const legacyOptions = {
      provider,
      model,
      baseUrl: api.baseUrl,
      interfaceProvider,
      maxTokens: params?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      modelProfiles: ((source.models ?? []) as ModelJsonModelProfile[]).map(
        (profile, index) => ({ ...profile, id: models[index].id }),
      ),
    };
    const profile = activeModelBudgetProfiles(legacyOptions).at(0);
    const effective = rawCapabilitiesFor(legacyOptions);
    let active = models.find((entry) => entry.id === profile?.id);
    if (!active) {
      let id = `profile-${createHash("sha256")
        .update(
          JSON.stringify([provider, model, api.baseUrl, interfaceProvider]),
        )
        .digest("hex")
        .slice(0, 16)}`;
      while (models.some((entry) => entry.id === id)) id += "-m";
      active = { id, provider, model };
      models.push(active);
    }
    Object.assign(active, {
      provider,
      model,
      baseUrl: api.baseUrl,
      interfaceProvider,
    });
    const context = profile?.contextWindowTokens ?? params?.contextWindowTokens;
    if (context !== undefined) active.contextWindowTokens = context;
    if (api.apiKeyEnv !== undefined) active.apiKeyEnv = api.apiKeyEnv;
    else delete active.apiKeyEnv;
    if (api.promptCache !== undefined) active.promptCache = api.promptCache;
    delete active.needsConfiguration;
    if (effective.capability && !effective.source.startsWith("builtin:")) {
      active.reasoningCapabilities = effective.capability;
      if (
        effective.source === "model-metadata" ||
        effective.source === "active-probe"
      )
        active.reasoningCapabilitySource = effective.source;
      else delete active.reasoningCapabilitySource;
    }
    for (const entry of models)
      if (
        entry.maxOutputTokens === undefined &&
        params?.maxTokens !== undefined
      )
        entry.maxOutputTokens = params.maxTokens;
    activeProfileId = active.id;
  }
  for (const entry of models) {
    if (entry.id === activeProfileId) {
      entry.temperature ??= params?.temperature;
      entry.reasoning ??= params?.reasoning;
    }
    if (entry.contextWindowTokens !== undefined) {
      entry.detectedContextWindowTokens = entry.contextWindowTokens;
      delete entry.contextWindowTokens;
    }
    if (entry.maxOutputTokens === LEGACY_DEFAULT_MAX_OUTPUT_TOKENS)
      delete entry.maxOutputTokens;
    if (
      entry.detectedContextWindowTokens !== undefined ||
      entry.reasoningCapabilitySource === "model-metadata" ||
      entry.reasoningCapabilitySource === "active-probe"
    )
      entry.detectedRouteKey = modelProfileRouteKey(entry, entry.provider);
  }
  return {
    schemaVersion: 2,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    models,
  };
}
function validateEntry(entry: ModelEntry): void {
  if (
    entry.apiKeyEnv !== undefined &&
    (typeof entry.apiKeyEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.apiKeyEnv))
  )
    throw new ConfigError("Invalid API key env", "INVALID_FIELD");
  if (
    entry.needsConfiguration !== undefined &&
    typeof entry.needsConfiguration !== "boolean"
  )
    throw new ConfigError("Invalid configuration marker", "INVALID_FIELD");
  for (const value of [
    entry.contextWindowTokens,
    entry.maxOutputTokens,
    entry.detectedContextWindowTokens,
  ]) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    )
      throw new ConfigError("Invalid model token limit", "INVALID_MAX_TOKENS");
  }
  if (
    entry.detectedRouteKey !== undefined &&
    typeof entry.detectedRouteKey !== "string"
  )
    throw new ConfigError("Invalid detected route", "INVALID_FIELD");
  validateModelJson({
    provider: entry.provider,
    defaultModel: entry.model,
    apiConfig: {
      baseUrl: entry.baseUrl ?? "http://localhost",
      interfaceProvider: entry.interfaceProvider,
      promptCache: entry.promptCache,
    },
    llmParams: {
      maxTokens: resolveEntryTokenLimits(entry).effectiveMaxOutputTokens,
      temperature: entry.temperature,
      reasoning: entry.reasoning,
    },
    models: [projectModelEntry(entry)],
  });
}
export async function readModelDocument(
  options: { modelJsonPath?: string } = {},
): Promise<ModelDocument> {
  try {
    const raw = sourceRecord(await loadModelJson(options));
    const legacy = !Object.hasOwn(raw, "schemaVersion");
    const document = migrateModelDocument(raw);
    for (const entry of document.models) {
      clearUnsupportedAnthropicEffortPreference(entry, options.modelJsonPath);
      if (
        legacy &&
        entry.reasoning &&
        configurationComplete(entry) &&
        capabilitiesFor(entryReasoningOptions(entry)).capability
      ) {
        try {
          resolveRequestReasoning(entryReasoningOptions(entry));
        } catch (error) {
          if (error instanceof ConfigError) delete entry.reasoning;
          else throw error;
        }
      }
    }
    return normalizeModelDocument(document);
  } catch (error) {
    if (error instanceof ConfigError && error.code === "FILE_NOT_FOUND")
      return { schemaVersion: 2, models: [] };
    throw error;
  }
}
export async function loadProjectedModelJson(
  options: { modelJsonPath?: string } = {},
  entryId?: string,
): Promise<ModelJsonConfig> {
  const projected = projectModelDocument(
    await readModelDocument(options),
    entryId,
  );
  if (!projected)
    throw new ConfigError("No active model configured", "FILE_NOT_FOUND");
  return projected;
}

export class ModelSettingsError extends Error {
  constructor(readonly code: "MODEL_NOT_FOUND" | "MODEL_CONFIG_INCOMPLETE") {
    super(
      code === "MODEL_NOT_FOUND"
        ? "Model entry not found"
        : "Model configuration incomplete",
    );
  }
}

/** Missing explicit entries fall back, but incomplete entries must be repaired. */
export function resolveModelEntry(
  document: ModelDocument,
  modelEntryId?: string,
): {
  entry: ModelEntry;
  source: "explicit" | "default";
  removedEntryId?: string;
} {
  const explicit =
    modelEntryId === undefined
      ? undefined
      : document.models.find((entry) => entry.id === modelEntryId);
  const entry =
    explicit ??
    document.models.find((entry) => entry.id === document.activeProfileId);
  if (!entry)
    throw new ConfigError("No active model configured", "FILE_NOT_FOUND");
  if (!configurationComplete(entry))
    throw new ModelSettingsError("MODEL_CONFIG_INCOMPLETE");
  return {
    entry,
    source: explicit ? "explicit" : "default",
    ...(modelEntryId !== undefined && !explicit
      ? { removedEntryId: modelEntryId }
      : {}),
  };
}
