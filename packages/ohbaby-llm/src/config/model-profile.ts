import type { InterfaceProviderKind } from "./types.js";

/** Trailing route separators are equivalent; retain path/query/model case. */
export function normalizedEndpoint(value: string): string {
  return /[?#]/u.test(value) ? value : value.replace(/\/+$/u, "");
}

/** Missing route constraints identify legacy generic profiles, not the active route. */
export function modelProfileRouteKey(
  profile: {
    readonly provider?: string;
    readonly model: string;
    readonly baseUrl?: string;
    readonly interfaceProvider?: InterfaceProviderKind;
  },
  defaultProvider: string,
): string {
  return JSON.stringify([
    profile.provider ?? defaultProvider,
    profile.model,
    profile.interfaceProvider ?? null,
    profile.baseUrl === undefined ? null : normalizedEndpoint(profile.baseUrl),
  ]);
}

/**
 * Select the active route before the legacy registry folds identifiers and drops routes.
 * For budgeting, maxOutputTokens is the ordinary request preference.
 */
export function activeModelBudgetProfiles(
  config: Pick<
    import("./types.js").LLMConfig,
    | "provider"
    | "model"
    | "baseUrl"
    | "interfaceProvider"
    | "modelProfiles"
    | "maxTokens"
  >,
): readonly import("./types.js").ModelJsonModelProfile[] {
  const matching =
    config.modelProfiles?.filter(
      (profile) =>
        profile.model === config.model &&
        (profile.provider ?? config.provider) === config.provider &&
        (profile.interfaceProvider === undefined ||
          profile.interfaceProvider === config.interfaceProvider) &&
        (profile.baseUrl === undefined ||
          normalizedEndpoint(profile.baseUrl) ===
            normalizedEndpoint(config.baseUrl)),
    ) ?? [];
  matching.sort((a, b) => profileSpecificity(a) - profileSpecificity(b));
  const profile = matching.at(-1);
  // Profile routing selects window/capability metadata; output is the ordinary request preference.
  return profile === undefined
    ? []
    : [{ ...profile, maxOutputTokens: config.maxTokens }];
}

export function profileSpecificity(profile: {
  readonly provider?: string;
  readonly interfaceProvider?: InterfaceProviderKind;
  readonly baseUrl?: string;
}): number {
  return (
    Number(profile.provider !== undefined) +
    Number(profile.interfaceProvider !== undefined) +
    Number(profile.baseUrl !== undefined)
  );
}
