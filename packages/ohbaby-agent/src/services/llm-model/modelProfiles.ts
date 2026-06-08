const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024;
const MAX_OUTPUT_RESERVATION_RATIO = 0.5;

export type ModelProfileSource = "builtin" | "user" | "fallback";

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
  list(): readonly ModelProfile[];
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

interface BuiltinProfileRule {
  readonly provider: string;
  readonly modelPrefix: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly label?: string;
}

const BUILTIN_PROFILE_RULES: readonly BuiltinProfileRule[] = [
  {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    modelPrefix: "gpt-4.1",
    provider: "openai",
  },
  {
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    modelPrefix: "gpt-5",
    provider: "openai",
  },
  {
    contextWindowTokens: 200_000,
    maxOutputTokens: 100_000,
    modelPrefix: "o3",
    provider: "openai",
  },
  {
    contextWindowTokens: 200_000,
    maxOutputTokens: 100_000,
    modelPrefix: "o4-mini",
    provider: "openai",
  },
  {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    modelPrefix: "gpt-4-turbo",
    provider: "openai",
  },
  {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    modelPrefix: "gpt-4o-mini",
    provider: "openai",
  },
  {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    modelPrefix: "gpt-4o",
    provider: "openai",
  },
  {
    contextWindowTokens: 4_096,
    maxOutputTokens: 2_048,
    modelPrefix: "gpt-3.5-turbo",
    provider: "openai",
  },
  {
    contextWindowTokens: 8_192,
    maxOutputTokens: 4_096,
    modelPrefix: "gpt-4",
    provider: "openai",
  },
  {
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    modelPrefix: "claude-",
    provider: "anthropic",
  },
  {
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_192,
    modelPrefix: "deepseek-",
    provider: "deepseek",
  },
  {
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    modelPrefix: "glm-4",
    provider: "zhipu",
  },
];

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
    userProfiles.set(profileProviderModelKey(profile.provider, profile.model), profile);
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

    const resolvedProvider =
      normalizeProvider(provider) ?? defaultProvider ?? inferProvider(modelId);
    const userProfile = findUserProfile(
      userProfiles,
      bareUserProfiles,
      normalizedModel,
      resolvedProvider,
    );
    if (userProfile) {
      return userProfile;
    }

    const builtin = findBuiltinProfile(normalizedModel, resolvedProvider);
    if (builtin) {
      return builtin;
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
    list(): readonly ModelProfile[] {
      const builtins = BUILTIN_PROFILE_RULES.map(ruleToProfile);
      return dedupeProfiles([...userProfiles.values(), ...builtins]);
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
  const reservedOutputTokens = Math.min(
    requestedOutputTokens,
    profile.maxOutputTokens,
    maxOutputReservation(profile.contextWindowTokens, safetyMarginTokens),
  );
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

function findBuiltinProfile(
  modelId: string,
  provider: string | undefined,
): ModelProfile | undefined {
  const normalizedModelCandidates = modelKeyCandidates(modelId);
  const normalizedProvider = normalizeProvider(provider);
  const matchingRules = BUILTIN_PROFILE_RULES.filter((rule) => {
    const providerMatches =
      normalizedProvider === undefined ||
      normalizedProvider === rule.provider ||
      normalizedProvider === "custom" ||
      !isKnownBuiltinProvider(normalizedProvider);
    const normalizedPrefix = normalizeKey(rule.modelPrefix);
    return (
      providerMatches &&
      normalizedModelCandidates.some((candidate) =>
        candidate.startsWith(normalizedPrefix),
      )
    );
  }).sort((left, right) => right.modelPrefix.length - left.modelPrefix.length);

  if (matchingRules.length === 0) {
    return undefined;
  }

  const rule = matchingRules[0];
  return {
    ...ruleToProfile(rule),
    model: modelId.trim(),
  };
}

function isKnownBuiltinProvider(provider: string): boolean {
  return BUILTIN_PROFILE_RULES.some((rule) => rule.provider === provider);
}

function modelKeyCandidates(modelId: string): readonly string[] {
  const normalized = normalizeKey(modelId);
  const candidates = [normalized];
  const slashIndex = normalized.indexOf("/");
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    candidates.push(normalized.slice(slashIndex + 1));
  }
  return [...new Set(candidates)];
}

function ruleToProfile(rule: BuiltinProfileRule): ModelProfile {
  return {
    contextWindowTokens: rule.contextWindowTokens,
    id: `${rule.provider}:${rule.modelPrefix}`,
    maxOutputTokens: rule.maxOutputTokens,
    model: rule.modelPrefix,
    provider: rule.provider,
    ...(rule.label ? { label: rule.label } : {}),
    source: "builtin",
  };
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

function maxOutputReservation(
  contextWindowTokens: number,
  safetyMarginTokens: number,
): number {
  const availableTokens = Math.max(0, contextWindowTokens - safetyMarginTokens);
  return Math.floor(availableTokens * MAX_OUTPUT_RESERVATION_RATIO);
}

function dedupeProfiles(profiles: readonly ModelProfile[]): ModelProfile[] {
  const byId = new Map<string, ModelProfile>();
  for (const profile of profiles) {
    byId.set(profile.id, profile);
  }
  return Array.from(byId.values());
}

function inferProvider(modelId: string): string | undefined {
  const normalized = normalizeKey(modelId);
  if (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4-mini")
  ) {
    return "openai";
  }
  if (normalized.startsWith("claude-")) {
    return "anthropic";
  }
  if (normalized.startsWith("deepseek-")) {
    return "deepseek";
  }
  if (normalized.startsWith("glm-4")) {
    return "zhipu";
  }
  return undefined;
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
