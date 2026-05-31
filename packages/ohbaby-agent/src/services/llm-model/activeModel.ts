import type { LLMConfig, InterfaceProviderKind } from "../../config/index.js";
import {
  createModelProfileRegistry,
  type ModelProfile,
} from "./modelProfiles.js";

export interface ActiveModelSummary {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly profile?: ModelProfile;
}

export function summarizeActiveModel(config: LLMConfig): ActiveModelSummary {
  const registry = createModelProfileRegistry({
    defaultProvider: config.provider,
    userProfiles: config.modelProfiles,
  });
  const profile = registry.resolve(config.model, config.provider);
  const label = profile.label ?? config.model;

  return {
    id: `${config.provider}:${config.model}`.toLowerCase(),
    provider: config.provider,
    model: config.model,
    label,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    interfaceProvider: config.interfaceProvider,
    profile,
  };
}

export function listConfiguredModelSummaries(
  config: LLMConfig,
): readonly ActiveModelSummary[] {
  return [summarizeActiveModel(config)];
}
