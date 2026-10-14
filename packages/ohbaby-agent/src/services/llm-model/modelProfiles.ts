const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024;

export type ModelProfileSource = "user" | "fallback";

export interface ModelProfile {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly label?: string;
  readonly source: ModelProfileSource;
}

export interface ModelProfileRegistration {
  readonly id?: string;
  readonly provider?: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
  readonly label?: string;
}

export interface TokenBudgetOptions {
  readonly requestedOutputTokens?: number;
  readonly safetyMarginTokens?: number;
  readonly usedInputTokens?: number;
}

export interface TokenBudget {
  readonly contextWindowTokens: number;
  readonly inputBudgetTokens: number;
  readonly maxOutputTokens: number;
  readonly modelId: string;
  readonly remainingInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly usageRatio: number;
  readonly usedInputTokens: number;
}

export interface ModelProfileRegistry {
  resolve(modelId: string, provider?: string): ModelProfile;
  calculateBudget(
    modelId: string,
    options?: TokenBudgetOptions & { readonly provider?: string },
  ): TokenBudget;
}

export interface ModelProfileRegistryOptions {
  readonly defaultProvider?: string;
  readonly fallbackContextWindowTokens?: number;
  readonly fallbackMaxOutputTokens?: number;
  readonly userProfiles?: readonly ModelProfileRegistration[];
}

export function createModelProfileRegistry(
  options: ModelProfileRegistryOptions = {},
): ModelProfileRegistry {
  const defaultProvider = normalizeProvider(options.defaultProvider);
  const fallbackContextWindowTokens = normalizePositiveInteger(
    options.fallbackContextWindowTokens,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  const fallbackMaxOutputTokens = normalizePositiveInteger(
    options.fallbackMaxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
  );
  const userProfiles = new Map<string, ModelProfile>();
  const bareUserProfiles = new Map<string, ModelProfile | null>();

  for (const registration of options.userProfiles ?? []) {
    const profile = normalizeUserProfile(registration, defaultProvider);
    userProfiles.set(profileIdKey(profile.id), profile);
    userProfiles.set(
      profileProviderModelKey(profile.provider, profile.model),
      profile,
    );
    registerBareUserProfile(bareUserProfiles, profile);
  }

  function resolve(modelId: string, provider?: string): ModelProfile {
    assertString(modelId, "modelId");
    const normalizedModel = modelId.trim();
    if (normalizedModel === "") {
      return fallbackProfile({
        contextWindowTokens: 4_096,
        maxOutputTokens: fallbackMaxOutputTokens,
        model: "default",
        provider: normalizeProvider(provider) ?? defaultProvider ?? "default",
      });
    }

    const resolvedProvider = normalizeProvider(provider) ?? defaultProvider;
    const userProfile = findUserProfile(
      userProfiles,
      bareUserProfiles,
      normalizedModel,
      resolvedProvider,
    );
    if (userProfile) {
      return userProfile;
    }

    return fallbackProfile({
      contextWindowTokens: fallbackContextWindowTokens,
      maxOutputTokens: fallbackMaxOutputTokens,
      model: normalizedModel,
      provider: resolvedProvider ?? "custom",
    });
  }

  return {
    calculateBudget(modelId, budgetOptions = {}): TokenBudget {
      return calculateTokenBudget(
        resolve(modelId, budgetOptions.provider),
        budgetOptions,
      );
    },
    resolve,
  };
}

export function calculateTokenBudget(
  profile: ModelProfile,
  options: TokenBudgetOptions = {},
): TokenBudget {
  const requestedOutputTokens = normalizePositiveInteger(
    options.requestedOutputTokens,
    profile.maxOutputTokens,
  );
  const safetyMarginTokens = Math.min(
    normalizeNonNegativeInteger(
      options.safetyMarginTokens,
      DEFAULT_SAFETY_MARGIN_TOKENS,
    ),
    profile.contextWindowTokens,
  );
  const reservedOutputTokens = requestedOutputTokens;
  const inputBudgetTokens = Math.max(
    0,
    profile.contextWindowTokens - reservedOutputTokens - safetyMarginTokens,
  );
  const usedInputTokens = normalizeNonNegativeInteger(
    options.usedInputTokens,
    0,
  );
  const usageRatio =
    inputBudgetTokens === 0 ? 1 : usedInputTokens / inputBudgetTokens;

  return {
    contextWindowTokens: profile.contextWindowTokens,
    inputBudgetTokens,
    maxOutputTokens: profile.maxOutputTokens,
    modelId: profile.id,
    remainingInputTokens: Math.max(0, inputBudgetTokens - usedInputTokens),
    reservedOutputTokens,
    safetyMarginTokens,
    usageRatio,
    usedInputTokens,
  };
}

function findUserProfile(
  profiles: ReadonlyMap<string, ModelProfile>,
  bareProfiles: ReadonlyMap<string, ModelProfile | null>,
  modelId: string,
  provider: string | undefined,
): ModelProfile | undefined {
  const idMatch = profiles.get(profileIdKey(modelId));
  if (idMatch) {
    return idMatch;
  }

  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider) {
    return profiles.get(profileProviderModelKey(normalizedProvider, modelId));
  }

  const bareMatch = bareProfiles.get(profileBareModelKey(modelId));
  if (bareMatch) {
    return bareMatch;
  }
  return undefined;
}

function normalizeUserProfile(
  registration: ModelProfileRegistration,
  defaultProvider: string | undefined,
): ModelProfile {
  const model = registration.model.trim();
  const provider =
    normalizeProvider(registration.provider) ?? defaultProvider ?? "custom";
  const explicitId = registration.id?.trim();
  const id = (
    explicitId === undefined || explicitId === ""
      ? `${provider}:${model}`
      : explicitId
  ).toLowerCase();

  return {
    contextWindowTokens: normalizePositiveInteger(
      registration.contextWindowTokens,
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    ),
    id,
    maxOutputTokens: normalizePositiveInteger(
      registration.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
    ),
    model,
    provider,
    ...(registration.label ? { label: registration.label } : {}),
    source: "user",
  };
}

function fallbackProfile(input: {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly provider: string;
}): ModelProfile {
  return {
    contextWindowTokens: input.contextWindowTokens,
    id: `${input.provider}:${input.model}`.toLowerCase(),
    maxOutputTokens: input.maxOutputTokens,
    model: input.model,
    provider: input.provider,
    source: "fallback",
  };
}

function registerBareUserProfile(
  profiles: Map<string, ModelProfile | null>,
  profile: ModelProfile,
): void {
  const key = profileBareModelKey(profile.model);
  if (!profiles.has(key)) {
    profiles.set(key, profile);
    return;
  }

  const existing = profiles.get(key);
  if (existing?.id !== profile.id) {
    profiles.set(key, null);
  }
}

function profileIdKey(id: string): string {
  return `id:${normalizeKey(id)}`;
}

function profileProviderModelKey(provider: string, model: string): string {
  return `provider:${normalizeProvider(provider) ?? "custom"}:${normalizeKey(
    model,
  )}`;
}

function profileBareModelKey(model: string): string {
  return `model:${normalizeKey(model)}`;
}

function normalizeProvider(provider: string | undefined): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  return normalized;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.ceil(value);
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.ceil(value);
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
}
