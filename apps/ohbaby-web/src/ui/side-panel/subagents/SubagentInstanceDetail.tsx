import { ChevronLeft, Square } from "lucide-react";
import type {
  createSubagentConversationReader,
  UiBackendClient,
  UiSubagentInstance,
} from "ohbaby-sdk";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  readingMemory,
  SubagentConversationBody,
  type SubagentReadingCache,
} from "../../session/SubagentConversationBody.js";
import { readableError } from "../../shared/error-text.js";
import type { SubagentWatchCoordinator } from "../../shared/subagent-watch-owner.js";
import { IconButton } from "../../shared/IconButton.js";
import { useDelayed } from "../../shared/use-delayed.js";
import { stoppableExecutionId } from "./instance-status.js";
import { InstanceStatus } from "./InstanceStatus.js";

type ConversationReader = ReturnType<typeof createSubagentConversationReader>;

function errorText(error: unknown): string {
  return readableError(error instanceof Error ? error.message : String(error));
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

/**
 * One instance's read-only conversation with its current status and Stop
 * (03 §4.9). The header always shows the instance snapshot's status, never a
 * historical execution's (improve-2/05 item 3). The conversation reader
 * belongs to the page, so leaving for the list and coming back keeps the
 * loaded pages and the reading position.
 */
export function SubagentInstanceDetail(props: {
  readonly client: UiBackendClient;
  readonly rootSessionId: string;
  readonly instance: UiSubagentInstance;
  readonly reader: ConversationReader;
  readonly watch: SubagentWatchCoordinator;
  readonly readingCache: SubagentReadingCache;
  readonly onBack: () => void;
  /** Called after a Stop answer, so the list snapshot is reloaded. */
  readonly onRefresh: () => void;
}): ReactElement {
  const { client, rootSessionId, instance, reader, watch } = props;
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => reader.subscribe(listener), [reader]),
    () => reader.getSnapshot(),
  );
  // Opening a detail is the user's latest reading choice: take the one watch.
  useEffect(() => {
    watch.claim("panel");
  }, [watch]);
  // Only a fresh open jumps to the execution anchor; returning to an instance
  // the page's reader still holds restores where the user was (I3-06).
  const [followAnchor] = useState(
    () => reader.getSnapshot().selected?.subagentId !== instance.subagentId,
  );

  // Until the SDK reader can open an instance by subagentId (improve-2 B4),
  // read the latest execution's record once and open the conversation from it.
  const latestExecutionId = instance.latestExecutionId;
  const opened = state.selected?.subagentId === instance.subagentId;
  const [openError, setOpenError] = useState<string>();
  const [openAttempt, setOpenAttempt] = useState(0);
  const showOpening = useDelayed(
    latestExecutionId !== undefined && !opened && openError === undefined,
    300,
  );
  useEffect(() => {
    if (opened || !latestExecutionId) return;
    const controller = new AbortController();
    setOpenError(undefined);
    void (async (): Promise<void> => {
      try {
        if (!client.getSubagentExecutionView)
          throw new Error("Subagent conversations are unavailable");
        const view = await client.getSubagentExecutionView({
          rootSessionId,
          executionId: latestExecutionId,
          limit: 1,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) await reader.select(view.execution);
      } catch (error) {
        if (!controller.signal.aborted) setOpenError(errorText(error));
      }
    })();
    return (): void => {
      controller.abort();
    };
  }, [client, reader, rootSessionId, latestExecutionId, opened, openAttempt]);

  // Stopping lasts until this execution has ended and cleaned up.
  const [stoppingExecutionId, setStoppingExecutionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const executionId = stoppableExecutionId(instance);
  const stopping =
    instance.settling ||
    (stoppingExecutionId !== undefined &&
      stoppingExecutionId === instance.currentExecutionId);
  const stop = async (target: string): Promise<void> => {
    setStoppingExecutionId(target);
    setStopError(undefined);
    try {
      if (!client.stopSubagent)
        throw new Error("Stopping a subagent is not supported by this server");
      const result = await client.stopSubagent({
        rootSessionId,
        subagentId: instance.subagentId,
        expectedExecutionId: target,
      });
      if (
        result.outcome === "not_running" ||
        result.outcome === "execution_changed"
      )
        setStoppingExecutionId(undefined);
    } catch (error) {
      // The stop already went through when only the receipt's snapshot moved
      // on (improve-2 B4); the refreshed list says what really happened.
      if (errorCode(error) !== "SUBAGENT_SNAPSHOT_CHANGED") {
        setStoppingExecutionId(undefined);
        setStopError(errorText(error));
      }
    } finally {
      props.onRefresh();
    }
  };

  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [instance.subagentId]);
  const identity = `${rootSessionId}:${instance.subagentId}`;
  const memory = readingMemory(props.readingCache, identity);

  return (
    <section className="ohb-subagent-detail" aria-label={instance.displayName}>
      <header className="ohb-subagent-detail-header">
        <IconButton label="Back to subagents" onClick={props.onBack}>
          <ChevronLeft aria-hidden="true" size={16} />
        </IconButton>
        <div className="ohb-subagent-detail-title">
          <h2 ref={heading} tabIndex={-1}>
            {instance.displayName}
          </h2>
          <p title={instance.description}>{instance.description}</p>
        </div>
        <InstanceStatus instance={instance} role="status" />
        {stopping ? (
          <button type="button" className="ohb-subagent-stop" disabled>
            <Square aria-hidden="true" size={9} fill="currentColor" />
            Stopping…
          </button>
        ) : executionId ? (
          <button
            type="button"
            className="ohb-subagent-stop"
            onClick={() => {
              void stop(executionId);
            }}
          >
            <Square aria-hidden="true" size={9} fill="currentColor" />
            Stop
          </button>
        ) : null}
      </header>
      {stopError ? (
        <p className="ohb-side-notice" role="alert">
          {stopError}
        </p>
      ) : null}
      {openError ? (
        <p className="ohb-side-notice" role="alert">
          {openError}{" "}
          <button
            type="button"
            onClick={() => {
              setOpenAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
      {latestExecutionId ? null : (
        <p className="ohb-side-notice">Not started yet.</p>
      )}
      {showOpening ? (
        <p className="ohb-side-notice" role="status">
          Loading…
        </p>
      ) : null}
      {opened ? (
        <div className="ohb-subagent-detail-body">
          <SubagentConversationBody
            reader={reader}
            state={state}
            memory={memory}
            identity={identity}
            followAnchor={followAnchor}
            approvalRequired={instance.approvalBlocked}
          />
        </div>
      ) : null}
    </section>
  );
}
