import {
  createSubagentConversationReader,
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
} from "react";
import type { SubagentReadingCache } from "../../session/SubagentConversationBody.js";
import { SubagentInstanceDetail } from "./SubagentInstanceDetail.js";
import { SubagentInstanceList } from "./SubagentInstanceList.js";
import type { SubagentAnchor } from "../side-pages.js";
import {
  findInstance,
  isClosedInstance,
  type SubagentInstances,
} from "../../shared/subagent-instances.js";

/**
 * The Subagents page: the instance list and one instance's detail in the same
 * tab. It owns the only subagent conversation reader in the app (the server
 * keeps one watch per client, and the panel renders only its selected tab),
 * kept while the list shows so returning to the same instance resumes reading. Unmounting it
 * (closing the tab or the panel, switching chats) releases every read; it
 * never stops or closes a subagent.
 */
export function SubagentsPage(props: {
  readonly client: UiBackendClient;
  readonly rootSessionId: string;
  readonly selectedSubagentId?: string;
  /** An explicit request to show one delegation (the chat's entry link). */
  readonly anchor?: SubagentAnchor;
  /** The session's instance snapshot, shared with the chat's entries. */
  readonly instances: SubagentInstances;
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
  const { state, refresh } = props.instances;

  const selected = selectedSubagentId
    ? findInstance(state, selectedSubagentId)
    : undefined;
  // A complete snapshot without the instance means it was closed: back to the list.
  const closed =
    selectedSubagentId !== undefined &&
    isClosedInstance(state, selectedSubagentId);
  useEffect(() => {
    if (closed && selectedSubagentId) back(selectedSubagentId);
  }, [closed, selectedSubagentId, back]);
  // A held conversation whose instance left the complete snapshot was closed:
  // release its watch even while the list is showing.
  useEffect(() => {
    const held = conversation.getSnapshot().selected?.subagentId;
    if (held !== undefined && isClosedInstance(state, held))
      conversation.close();
  }, [state, conversation]);

  if (selected)
    return (
      <SubagentInstanceDetail
        key={selected.subagentId}
        client={client}
        rootSessionId={rootSessionId}
        instance={selected}
        reader={conversation}
        anchor={props.anchor}
        readingCache={props.readingCache}
        onBack={() => {
          back(selected.subagentId);
        }}
        onRefresh={refresh}
      />
    );
  return (
    <SubagentInstanceList
      state={state}
      onSelect={select}
      focusSubagentId={returnFocus}
      onRetry={refresh}
    />
  );
}
