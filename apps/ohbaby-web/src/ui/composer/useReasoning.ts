import type {
  UiBackendClient,
  UiReasoningCapabilityView,
  UiReasoningConfig,
  UiSession,
  UiSettingsModel,
} from "ohbaby-sdk";
import { useEffect, useRef, useState } from "react";

export type ReasoningClient = Pick<
  UiBackendClient,
  "getCurrentModel" | "subscribeEvents" | "updateSessionReasoning"
>;

/** What the thinking control shows; one state feeds both the desktop select and the phone More menu. */
export type ReasoningState =
  | { readonly kind: "hidden" }
  | { readonly kind: "detecting"; readonly reason?: string }
  | { readonly kind: "unknown"; readonly reason?: string }
  | {
      readonly kind: "choice";
      readonly value: string;
      readonly options: readonly {
        readonly value: string;
        readonly label: string;
      }[];
      readonly error?: string;
      readonly select: (value: string) => void;
    };

/**
 * The chat's model's reasoning capability (from `GET /v1/model?sessionId`,
 * reread on `model.invalidated`) and the session's preference, saved per
 * session. `entry` is the settings entry the chat resolves to: a draft reads
 * its capability there, and its `reasoningDefault` is what an unset
 * preference falls back to (session-model 02 P11).
 */
export function useReasoning(
  client: ReasoningClient,
  session: UiSession | null,
  onChange: (reasoning: UiReasoningConfig | undefined) => void,
  entry?: UiSettingsModel,
): ReasoningState {
  const [modelView, setView] = useState<{
    client: ReasoningClient;
    view: UiReasoningCapabilityView | undefined;
  }>();
  const fetched = modelView?.client === client ? modelView.view : undefined;
  // A draft has no session to ask about, so its choice speaks for itself.
  const view = session === null && entry ? entry.reasoning : fetched;
  const localPreference = useRef<
    | {
        client: ReasoningClient;
        sessionId: string | undefined;
        reasoning: UiReasoningConfig;
      }
    | undefined
  >(undefined);
  const [preference, setPreference] = useState<UiReasoningConfig | undefined>(
    session?.reasoning,
  );
  const [error, setError] = useState<string>();
  const viewGeneration = useRef(0);
  useEffect(() => {
    viewGeneration.current++;
    return (): void => {
      viewGeneration.current++;
    };
  }, [client, session?.id]);
  useEffect(() => {
    if (
      view?.status === "identified" &&
      preference &&
      (view.mode === "none" ||
        (preference.enabled === false && !view.supportsDisabled) ||
        (preference.enabled !== false &&
          preference.effort !== undefined &&
          !view.efforts.includes(preference.effort)))
    ) {
      // Clear the displayed preference as well as the submitted value. A
      // later switch back must not revive a level the previous model reset.
      localPreference.current = undefined;
      setPreference(undefined);
      onChange(undefined);
    }
  }, [view, preference, onChange]);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const local = localPreference.current;
    if (
      local?.client === client &&
      local.sessionId === session?.id &&
      (local.reasoning.enabled !== session?.reasoning?.enabled ||
        local.reasoning.effort !== session?.reasoning?.effort)
    )
      return;
    localPreference.current = undefined;
    setPreference(session?.reasoning);
  }, [client, session?.id, session?.reasoning]);
  const sessionId = session?.id;
  // A chat rereads when it switches entry, or when the list reloads that
  // entry's capability (after Detect again, which sends no model event).
  const entryReasoning = session ? entry?.reasoning : undefined;
  useEffect(() => {
    let closed = false;
    let generation = 0;
    const refresh = (): void => {
      const request = ++generation;
      void client
        .getCurrentModel(sessionId === undefined ? undefined : { sessionId })
        .then((model) => {
          if (!closed && request === generation)
            setView(
              model?.reasoning ? { client, view: model.reasoning } : undefined,
            );
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = client.subscribeEvents((event) => {
      // Session preferences arrive through props; token events do not change
      // model capabilities and must not trigger a metadata request per token.
      if (event.type === "model.invalidated") refresh();
    });
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return (): void => {
      closed = true;
      generation++;
      unsubscribe();
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, sessionId, entryReasoning]);
  const update = (reasoning: UiReasoningConfig): void => {
    const local = { client, sessionId: session?.id, reasoning };
    localPreference.current = local;
    onChange(reasoning);
    setPreference(reasoning);
    setError(undefined);
    if (!session) return;
    const sessionId = session.id;
    const generation = viewGeneration.current;
    pending.current = pending.current
      .catch(() => undefined)
      .then(() => client.updateSessionReasoning({ sessionId, reasoning }))
      .then((saved) => {
        if (
          viewGeneration.current === generation &&
          localPreference.current === local
        ) {
          // PATCH and session events travel independently. Keep the local
          // selection until the session stream echoes it, even after this ack.
          setPreference(saved.reasoning);
        }
      })
      .catch((failure: unknown) => {
        if (viewGeneration.current === generation)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
  };
  if (!view || (view.status === "identified" && view.mode === "none"))
    return { kind: "hidden" };
  if (view.status === "detecting")
    return {
      kind: "detecting",
      ...(view.reason === undefined ? {} : { reason: view.reason }),
    };
  if (view.status !== "identified")
    return {
      kind: "unknown",
      ...(view.reason === undefined ? {} : { reason: view.reason }),
    };
  const compatible =
    preference &&
    (preference.enabled !== false || view.supportsDisabled) &&
    (preference.effort === undefined ||
      view.efforts.includes(preference.effort));
  const fallback = entry?.reasoningDefault ?? view.default;
  const effective = compatible ? preference : fallback;
  const options = [
    ...(view.supportsDisabled ? [{ value: "off", label: "Off" }] : []),
    ...(view.mode === "binary"
      ? [{ value: "on", label: "On" }]
      : view.efforts.map((effort) => ({ value: effort, label: effort }))),
  ];
  return {
    kind: "choice",
    value:
      effective?.enabled === false
        ? "off"
        : view.mode === "binary"
          ? "on"
          : (effective?.effort ?? fallback?.effort ?? ""),
    options,
    ...(error === undefined ? {} : { error }),
    select: (value): void => {
      update(
        value === "off"
          ? { enabled: false }
          : value === "on"
            ? { enabled: true }
            : { enabled: true, effort: value },
      );
    },
  };
}
