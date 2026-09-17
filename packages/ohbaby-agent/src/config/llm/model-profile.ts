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

/** Select before the legacy model registry folds model identifiers and drops routes. */
export function activeModelProfiles(
  config: Pick<
    import("./types.js").LLMConfig,
    "provider" | "model" | "baseUrl" | "interfaceProvider" | "modelProfiles"
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
  return profile === undefined ? [] : [profile];
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
