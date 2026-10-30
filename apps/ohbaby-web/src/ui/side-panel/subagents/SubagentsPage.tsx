import {
  createSubagentConversationReader,
  createSubagentInstanceReader,
  type UiBackendClient,
} from "ohbaby-sdk";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SubagentReadingCache } from "../../session/SubagentConversationBody.js";
import type { SubagentWatchCoordinator } from "../../shared/subagent-watch-owner.js";
import { SubagentInstanceDetail } from "./SubagentInstanceDetail.js";
import { SubagentInstanceList } from "./SubagentInstanceList.js";

/**
 * The Subagents page: the instance list and one instance's detail in the same
 * tab. It owns one conversation reader for its details, kept while the list
 * shows so returning to the same instance resumes reading. Unmounting it
 * (closing the tab or the panel, switching chats) releases every read; it
 * never stops or closes a subagent.
 */
export function SubagentsPage(props: {
  readonly client: UiBackendClient;
  readonly rootSessionId: string;
  readonly selectedSubagentId?: string;
  readonly onSelect: (subagentId: string | undefined) => void;
  readonly readingCache: SubagentReadingCache;
  readonly watch: SubagentWatchCoordinator;
}): ReactElement {
  const { client, rootSessionId, selectedSubagentId, watch } = props;
  // The caller's callback may change every render; effects read the latest one.
  const onSelectRef = useRef(props.onSelect);
  useLayoutEffect(() => {
    onSelectRef.current = props.onSelect;
  }, [props.onSelect]);
  // The instance whose detail the user just left, so the list can focus its row.
  const [returnFocus, setReturnFocus] = useState<string>();
  const select = useCallback((subagentId: string | undefined): void => {
    setReturnFocus(undefined);
    onSelectRef.current(subagentId);
  }, []);
  const back = useCallback((subagentId: string): void => {
    setReturnFocus(subagentId);
    onSelectRef.current(undefined);
  }, []);
  const conversation = useMemo(
    () => createSubagentConversationReader(client, rootSessionId),
    [client, rootSessionId],
  );
  useEffect(
    () => (): void => {
      conversation.dispose();
    },
    [conversation],
  );
  // The chat's delegation sheet took the one watch: release it and leave the
  // detail, so nothing here keeps showing a conversation that stopped updating.
  useEffect(
    () =>
      watch.subscribe(() => {
        if (watch.owner() === "panel") return;
        if (conversation.getSnapshot().selected === undefined) return;
        conversation.close();
        onSelectRef.current(undefined);
      }),
    [watch, conversation],
  );
  // Only the root goes in the query; the client adds the current binding.
  const reader = useMemo(
    () => createSubagentInstanceReader(client, { rootSessionId }),
    [client, rootSessionId],
  );
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => reader.subscribe(listener), [reader]),
    () => reader.getSnapshot(),
  );
  useEffect(() => {
    void reader.refresh();
    // The SDK reader misses invalidations lost during a reconnect (improve-2 B4).
    const unsubscribe = client.subscribeEvents((event) => {
      if (event.type === "session.resync-required" && !event.disconnected)
        void reader.refresh();
    });
    return (): void => {
      unsubscribe();
      reader.dispose();
    };
  }, [client, reader]);

  const selected = selectedSubagentId
    ? state.snapshot?.instances.find(
        (instance) => instance.subagentId === selectedSubagentId,
      )
    : undefined;
  // A complete snapshot without the instance means it was closed: back to the list.
  const closed =
    selectedSubagentId !== undefined &&
    state.snapshot !== undefined &&
    selected === undefined;
  useEffect(() => {
    if (closed && selectedSubagentId) back(selectedSubagentId);
  }, [closed, selectedSubagentId, back]);
  // A held conversation whose instance left the complete snapshot was closed:
  // release its watch even while the list is showing.
  useEffect(() => {
    const held = conversation.getSnapshot().selected?.subagentId;
    if (
      held !== undefined &&
      state.snapshot &&
      !state.snapshot.instances.some((item) => item.subagentId === held)
    )
      conversation.close();
  }, [state.snapshot, conversation]);

  if (selected)
    return (
      <SubagentInstanceDetail
        key={selected.subagentId}
        client={client}
        rootSessionId={rootSessionId}
        instance={selected}
        reader={conversation}
        watch={watch}
        readingCache={props.readingCache}
        onBack={() => {
          back(selected.subagentId);
        }}
        onRefresh={() => {
          void reader.refresh();
        }}
      />
    );
  return (
    <SubagentInstanceList
      state={state}
      onSelect={select}
      focusSubagentId={returnFocus}
      onRetry={() => {
        void reader.refresh();
      }}
    />
  );
}
