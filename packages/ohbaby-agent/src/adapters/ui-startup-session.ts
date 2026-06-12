export type StartupSessionMode =
  | { readonly type: "fresh" }
  | { readonly type: "resume"; readonly sessionId: string }
  | { readonly type: "continue" };

export interface StartupSessionCandidate {
  readonly id: string;
  readonly kind: "primary" | "temporary";
  readonly updatedAt: number;
}

export function resolveStartupSession(
  mode: StartupSessionMode,
  candidates: readonly StartupSessionCandidate[],
): string | null {
  if (mode.type === "fresh") {
    return null;
  }

  if (mode.type === "resume") {
    return mode.sessionId;
  }

  const primaryCandidates = candidates
    .filter((candidate) => candidate.kind === "primary")
    .toSorted((left, right) => right.updatedAt - left.updatedAt);
  return primaryCandidates.length === 0 ? null : primaryCandidates[0].id;
}
