import { emitDiagnostic } from "../../observability/logger.js";
import { createHash } from "node:crypto";
import {
  ConfigError,
  createLLMClientFromConfig,
  type LLMClientInstance,
  type LLMConfig,
  type ReasoningConfig,
} from "ohbaby-llm";
import { coordinateModelConfig } from "../../config/llm/config-coordination.js";
import { loadModelEntryConfig } from "../../config/llm/manager.js";
import {
  configurationComplete,
  readModelDocument,
  resolveModelEntry,
  type ModelDocument,
  type ModelEntry,
} from "../../config/llm/model-document.js";
import {
  tokenUsageNormalization,
  NOOP_LOGGER,
  type Logger,
} from "../../observability/index.js";

export interface ResolvedModelConfig {
  readonly config: LLMConfig;
  readonly entry: ModelEntry;
  readonly source: "explicit" | "default";
  readonly removedEntryId?: string;
}

type ConfiguredSubagentClient =
  | { readonly status: "incomplete" | "unreadable" }
  | {
      readonly status: "configured";
      readonly entryId: string;
      readonly client: LLMClientInstance;
      readonly reasoning?: ReasoningConfig;
    };

export interface ResolvedModelClient {
  readonly client: LLMClientInstance;
  readonly entry: ModelEntry;
  readonly source: "explicit" | "default";
  readonly removedEntryId?: string;
}

/** A content-keyed pool leaves in-flight clients intact when configuration changes. */
export function createModelClientPool(options: {
  readonly llmClient?: LLMClientInstance;
  readonly createLLMClient?: (config: LLMConfig) => Promise<LLMClientInstance>;
  readonly logger?: Logger;
}): {
  resolve(
    projectDirectory: string,
    modelEntryId?: string,
  ): Promise<ResolvedModelClient>;
  read(
    projectDirectory: string,
    modelEntryId?: string,
  ): Promise<ResolvedModelConfig>;
  resolveSubagent(
    projectDirectory: string,
  ): Promise<ConfiguredSubagentClient | undefined>;
} {
  const clients = new Map<string, Promise<LLMClientInstance>>();
  async function configForEntry(
    projectDirectory: string,
    document: ModelDocument,
    entryId: string,
  ): Promise<LLMConfig> {
    if (options.llmClient) {
      const config = options.llmClient.config;
      return {
        ...config,
        apiKey: "injected-client",
        promptCache: config.promptCache ?? "auto",
      };
    }
    return loadModelEntryConfig({ projectDirectory }, entryId, document);
  }

  async function read(
    projectDirectory: string,
    modelEntryId?: string,
  ): Promise<ResolvedModelConfig> {
    return coordinateModelConfig(undefined, async () => {
      const document = await readModelDocument();
      if (options.llmClient && document.models.length === 0) {
        const config = options.llmClient.config;
        document.models.push({
          ...config.modelProfiles?.[0],
          id: "injected",
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          interfaceProvider: config.interfaceProvider,
          ...(config.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: config.contextWindowTokens }),
          maxOutputTokens: config.maxTokens,
          reasoning: config.reasoning,
        });
        document.activeProfileId = "injected";
      }
      const resolved = resolveModelEntry(document, modelEntryId);
      const config = await configForEntry(
        projectDirectory,
        document,
        resolved.entry.id,
      );
      return { ...resolved, config };
    });
  }
  async function clientFor(
    projectDirectory: string,
    config: LLMConfig,
  ): Promise<LLMClientInstance> {
    if (options.llmClient) return options.llmClient;
    const key = createHash("sha256")
      .update(JSON.stringify([projectDirectory, config]))
      .digest("hex");
    let client = clients.get(key);
    if (!client) {
      client = options.createLLMClient
        ? options.createLLMClient(config)
        : Promise.resolve(
            createLLMClientFromConfig(config, {
              tokenUsageReporter(diagnostic): void {
                emitDiagnostic(
                  options.logger ?? NOOP_LOGGER,
                  tokenUsageNormalization,
                  {
                    code: diagnostic.code,
                    field: diagnostic.field,
                    normalizedTotal: diagnostic.normalizedTotal,
                    protocol: diagnostic.protocol,
                    received: diagnostic.received,
                    retained: diagnostic.retained,
                  },
                );
              },
            }),
          );
      clients.set(key, client);
      // Only the current configuration needs a pool reference; running turns
      // retain their own clients. Bound retention when users edit repeatedly.
      if (clients.size > 64) {
        const oldest = clients.keys().next().value;
        if (oldest !== undefined) clients.delete(oldest);
      }
      void client.catch(() => {
        if (clients.get(key) === client) clients.delete(key);
      });
    }
    return client;
  }

  return {
    read,
    async resolve(
      projectDirectory,
      modelEntryId,
    ): Promise<ResolvedModelClient> {
      const resolved = await read(projectDirectory, modelEntryId);
      return {
        ...resolved,
        client: await clientFor(projectDirectory, resolved.config),
      };
    },
    async resolveSubagent(
      projectDirectory,
    ): Promise<ConfiguredSubagentClient | undefined> {
      // A fixed client supplied by the host handles every model request.
      if (options.llmClient) return undefined;
      // Read the choice and its client configuration together. Resolving the ID
      // again later could race deletion and silently pick the global default.
      const snapshot = await coordinateModelConfig(undefined, async () => {
        const document = await readModelDocument().catch((error: unknown) => {
          if (error instanceof ConfigError) return undefined;
          throw error;
        });
        if (!document) return { status: "unreadable" } as const;
        const setting = document.subagentModel;
        if (!setting) return undefined;
        const entry = document.models.find(({ id }) => id === setting.entryId);
        if (!entry) return undefined;
        if (!configurationComplete(entry))
          return { status: "incomplete" } as const;
        const config = await configForEntry(
          projectDirectory,
          document,
          entry.id,
        );
        return { status: "configured", setting, config } as const;
      });
      if (snapshot?.status !== "configured") return snapshot;
      return {
        status: "configured",
        ...snapshot.setting,
        client: await clientFor(projectDirectory, snapshot.config),
      };
    },
  };
}
