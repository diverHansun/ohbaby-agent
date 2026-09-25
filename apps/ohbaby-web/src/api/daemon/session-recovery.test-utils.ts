import type {
  UiSessionView,
  UiSnapshot,
  UiPermissionBinding,
} from "ohbaby-sdk";
export function recoveryBinding(
  rootSessionId: string | null = "session_1",
  bindingGeneration = 1,
): UiPermissionBinding & {
  runtimeEpoch: string;
  sessionRecoveryVersion: number;
} {
  return {
    runtimeEpoch: "epoch",
    permissionEpoch: "epoch",
    sessionRecoveryVersion: 1,
    rootSessionId,
    bindingGeneration,
  };
}
/** Versioned source fixtures; production clients never convert legacy snapshots. */
export function sessionViewFromSnapshot(
  snapshot: UiSnapshot,
  revision = 0,
  bindingGeneration = 1,
): UiSessionView {
  const session = snapshot.sessions.find(
    (value) => value.id === snapshot.activeSessionId,
  ) ??
    snapshot.sessions.at(0) ?? {
      id: snapshot.activeSessionId ?? "session_1",
      title: "Session",
      createdAt: "2026",
      updatedAt: "2026",
      messages: [],
    };
  return {
    version: {
      runtimeEpoch: "epoch",
      sessionId: session.id,
      viewGeneration: "view",
      sessionRevision: revision,
    },
    bindingGeneration,
    session,
    runs: snapshot.runs.filter((run) => run.sessionId === session.id),
    prompts:
      snapshot.prompts?.filter((prompt) => prompt.sessionId === session.id) ??
      [],
    history: { hasMore: false },
    reasoningMissing: false,
    todo: { status: "ready", value: null },
    goal: { status: "ready", value: null },
    context: { status: "ready", value: null },
  };
}
