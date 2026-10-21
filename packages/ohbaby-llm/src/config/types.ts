/**
 * Type definitions for the LLM configuration module.
 */

export type InterfaceProviderKind =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic";
export type PromptCachePolicy = "auto" | "enabled" | "disabled";

/** User intent; omitted fields receive product defaults at request time. */
export interface ReasoningConfig {
  readonly enabled?: boolean;
  readonly effort?: string;
}

/** Explicit, local capability evidence for a provider/model route. */
export interface ReasoningCapabilities {
  readonly mode: "none" | "binary" | "effort";
  readonly wire:
    | "none"
    | "openai"
    | "anthropic-adaptive"
    | "anthropic-budget"
    | "thinking"
    | "enable-thinking"
    | "reasoning";
  readonly supportsDisabled: boolean;
  readonly efforts?: readonly string[];
  /** Explicit weak-to-strong order for vendor labels. */
  readonly effortOrder?: readonly string[];
  readonly defaultEffort?: string;
  readonly effortMap?: Readonly<Record<string, string>>;
  readonly budgets?: Readonly<Record<string, number>>;
  readonly minBudgetTokens?: number;
  readonly temperature?: "allowed" | "unsupported" | "disabled-only";
}

/**
 * Raw configuration structure from model.json file.
 * This represents the user-editable configuration format.
 */
export interface ModelJsonConfig {
  /** LLM provider identifier (e.g., 'openai', 'zhipu') */
  provider: string;

  /** Model name to use (e.g., 'gpt-4', 'glm-4-plus') */
  defaultModel: string;

  /** API connection configuration */
  apiConfig: {
    /** Base URL for the API endpoint */
    baseUrl: string;

    /** Optional environment variable name containing the API key */
    apiKeyEnv?: string;

    /** API protocol adapter used for this provider */
    interfaceProvider?: InterfaceProviderKind;

    /** Whether ohbaby should add provider prompt-cache request controls */
    promptCache?: PromptCachePolicy;
  };

  /** LLM generation parameters */
  llmParams: {
    /** Sampling temperature (0-2) */
    temperature?: number;

    reasoning?: ReasoningConfig;

    /** Maximum tokens to generate */
    maxTokens: number;

    /** Optional full model context window used for local compaction decisions */
    contextWindowTokens?: number;
  };

  /** Optional user-registered model profiles for local budgeting decisions */
  models?: readonly ModelJsonModelProfile[];
}

export interface ModelJsonModelProfile {
  /** Stable profile id; defaults to '<provider>:<model>' */
  id?: string;

  /** Provider for this model; defaults to the top-level provider */
  provider?: string;

  /** Provider model identifier */
  model: string;

  /** Optional route constraints for reasoning capability overrides. */
  interfaceProvider?: InterfaceProviderKind;
  baseUrl?: string;
  reasoningCapabilities?: ReasoningCapabilities;
  reasoningCapabilitySource?: "model-metadata" | "active-probe";

  /** Display label for UI model lists */
  label?: string;

  /** Full context window for prompt plus output */
  contextWindowTokens: number;

  /** Maximum output tokens to reserve in token budgets */
  maxOutputTokens?: number;
}

/**
 * Resolved LLM configuration ready for use by consumers.
 * All values are resolved and validated.
 */
export interface LLMConfig {
  /** LLM provider identifier */
  provider: string;

  /** Model name */
  model: string;

  /** Resolved API key value */
  apiKey: string;

  /** Optional environment variable name containing the API key */
  apiKeyEnv?: string;

  /** API base URL */
  baseUrl: string;

  /** API protocol adapter used by the runtime client */
  interfaceProvider: InterfaceProviderKind;

  /** Resolved prompt-cache request policy */
  promptCache: PromptCachePolicy;

  /** Sampling temperature */
  temperature?: number;

  reasoning?: ReasoningConfig;

  /** Maximum tokens to generate */
  maxTokens: number;

  /** Optional full model context window used for local compaction decisions */
  contextWindowTokens?: number;

  /** User-registered model profiles plus the active context-window override */
  modelProfiles?: readonly ModelJsonModelProfile[];
}

/**
 * Error codes for configuration-related errors.
 */
export type ConfigErrorCode =
  | "FILE_NOT_FOUND"
  | "INVALID_JSON"
  | "MISSING_FIELD"
  | "INVALID_FIELD"
  | "INVALID_TEMPERATURE"
  | "INVALID_MAX_TOKENS"
  | "MISSING_API_KEY"
  | "EMPTY_API_KEY"
  | "LOAD_FAILED"
  | "WRITE_FAILED";

/**
 * Configuration error with structured error information.
 */
export class ConfigError extends Error {
  public readonly code: ConfigErrorCode;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: ConfigErrorCode,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.context = context;

    // Maintain proper stack trace in V8 environments
    Error.captureStackTrace(this, ConfigError);
  }
}
