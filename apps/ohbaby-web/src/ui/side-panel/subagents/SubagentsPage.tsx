import { createSubagentInstanceReader, type UiBackendClient } from "ohbaby-sdk";
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
import { SubagentInstanceDetail } from "./SubagentInstanceDetail.js";
import { SubagentInstanceList } from "./SubagentInstanceList.js";

/**
 * The Subagents page: the instance list and one instance's detail in the same
 * tab. Unmounting it (closing the tab or the panel, switching chats) releases
 * every read; it never stops or closes a subagent.
 */
export function SubagentsPage(props: {
  readonly client: UiBackendClient;
  readonly rootSessionId: string;
  readonly selectedSubagentId?: string;
  readonly onSelect: (subagentId: string | undefined) => void;
  readonly readingCache: SubagentReadingCache;
}): ReactElement {
  const { client, rootSessionId, selectedSubagentId } = props;
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

  if (selected)
    return (
      <SubagentInstanceDetail
        key={selected.subagentId}
        client={client}
        rootSessionId={rootSessionId}
        instance={selected}
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
