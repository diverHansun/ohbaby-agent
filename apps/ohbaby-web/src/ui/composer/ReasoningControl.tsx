import { Brain, ChevronDown } from "lucide-react";
import type {
  UiBackendClient,
  UiReasoningCapabilityView,
  UiReasoningConfig,
  UiSession,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

type ReasoningClient = Pick<
  UiBackendClient,
  "getCurrentModel" | "subscribeEvents" | "updateSessionReasoning"
>;

export function ReasoningControl(props: {
  readonly client: ReasoningClient;
  readonly session: UiSession | null;
  readonly onChange: (reasoning: UiReasoningConfig | undefined) => void;
}): ReactElement | null {
  const [modelView, setView] = useState<{
    client: ReasoningClient;
    view: UiReasoningCapabilityView | undefined;
  }>();
  const view = modelView?.client === props.client ? modelView.view : undefined;
  const localPreference = useRef<
    | {
        client: ReasoningClient;
        sessionId: string | undefined;
        reasoning: UiReasoningConfig;
      }
    | undefined
  >(undefined);
  const [preference, setPreference] = useState<UiReasoningConfig | undefined>(
    props.session?.reasoning,
  );
  const [error, setError] = useState<string>();
  const viewGeneration = useRef(0);
  useEffect(() => {
    viewGeneration.current++;
    return (): void => {
      viewGeneration.current++;
    };
  }, [props.client, props.session?.id]);
  useEffect(() => {
    if (
      view?.status === "identified" &&
      preference &&
      (view.mode === "none" ||
        (preference.enabled === false && !view.supportsDisabled) ||
        (preference.enabled !== false &&
          preference.effort !== undefined &&
          !view.efforts.includes(preference.effort)))
    )
      props.onChange(undefined);
  }, [view, preference, props.onChange]);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const local = localPreference.current;
    if (
      local?.client === props.client &&
      local.sessionId === props.session?.id &&
      (local.reasoning.enabled !== props.session?.reasoning?.enabled ||
        local.reasoning.effort !== props.session?.reasoning?.effort)
    )
      return;
    localPreference.current = undefined;
    setPreference(props.session?.reasoning);
  }, [props.client, props.session?.id, props.session?.reasoning]);
  useEffect(() => {
    let closed = false;
    let generation = 0;
    const refresh = (): void => {
      const request = ++generation;
      void props.client
        .getCurrentModel()
        .then((model) => {
          if (!closed && request === generation)
            setView(
              model?.reasoning
                ? { client: props.client, view: model.reasoning }
                : undefined,
            );
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = props.client.subscribeEvents((event) => {
      // Session preferences arrive through props; token events do not change
      // model capabilities and must not trigger a metadata request per token.
      if (event.type === "model.invalidated") refresh();
    });
    return (): void => {
      closed = true;
      generation++;
      unsubscribe();
    };
  }, [props.client]);
  const update = (reasoning: UiReasoningConfig): void => {
    const local = {
      client: props.client,
      sessionId: props.session?.id,
      reasoning,
    };
    localPreference.current = local;
    props.onChange(reasoning);
    setPreference(reasoning);
    setError(undefined);
    if (!props.session) return;
    const sessionId = props.session.id;
    const generation = viewGeneration.current;
    pending.current = pending.current
      .catch(() => undefined)
      .then(() => props.client.updateSessionReasoning({ sessionId, reasoning }))
      .then((session) => {
        if (
          viewGeneration.current === generation &&
          localPreference.current === local
        ) {
          // PATCH and session events travel independently. Keep the local
          // selection until the session stream echoes it, even after this ack.
          setPreference(session.reasoning);
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
    return null;
  if (view.status === "detecting")
    return (
      <span
        className="ohb-reasoning-status ohb-reasoning-detecting"
        aria-label="Detecting reasoning effort"
        role="status"
        title={view.reason}
      >
        <Brain className="ohb-reasoning-spinner" aria-hidden="true" size={14} />
      </span>
    );
  if (view.status !== "identified")
    return (
      <span
        className="ohb-reasoning-status ohb-reasoning-unknown"
        title={view.reason}
      >
        <Brain aria-hidden="true" size={14} />
        unknown
      </span>
    );
  const compatible =
    preference &&
    (preference.enabled !== false || view.supportsDisabled) &&
    (preference.effort === undefined ||
      view.efforts.includes(preference.effort));
  const effective = compatible ? preference : view.default;
  return (
    <label
      className="ohb-reasoning-control"
      title={error ?? "Reasoning effort"}
    >
      <Brain className="ohb-reasoning-icon" aria-hidden="true" size={14} />
      <select
        aria-label="Reasoning effort"
        aria-invalid={error ? true : undefined}
        value={
          effective?.enabled === false
            ? "off"
            : view.mode === "binary"
              ? "on"
              : (effective?.effort ?? view.default?.effort ?? "")
        }
        onChange={(event) => {
          update(
            event.target.value === "off"
              ? { enabled: false }
              : event.target.value === "on"
                ? { enabled: true }
                : { enabled: true, effort: event.target.value },
          );
        }}
      >
        {view.supportsDisabled && <option value="off">Off</option>}
        {view.mode === "binary" ? (
          <option value="on">On</option>
        ) : (
          view.efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))
        )}
      </select>
      <ChevronDown
        className="ohb-reasoning-chevron"
        aria-hidden="true"
        size={13}
      />
      {error && (
        <span className="ohb-reasoning-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
