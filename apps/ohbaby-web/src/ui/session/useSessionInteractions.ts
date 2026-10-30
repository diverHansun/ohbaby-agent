import {
  createSubagentConversationReader,
  createSubagentReader,
  type UiBackendClient,
} from "ohbaby-sdk";
import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SubagentWatchCoordinator } from "../shared/subagent-watch-owner.js";
import type { ViewModel } from "./selectors.js";
import { subagentSheetGeometry } from "./subagent-layout.js";
import type { SubagentReadingCache } from "./SubagentConversationBody.js";

/** The approval panel; its height reserves space at the bottom of the stream. */
export const APPROVAL_PANEL_SELECTOR = ".ohb-approval-panel";

/**
 * Subagent readers, the approval panel's visibility and the focus and layout
 * bookkeeping between the conversation, the approval panel and the subagent sheet.
 */
export function useSessionInteractions(input: {
  readonly client: UiBackendClient;
  readonly view: ViewModel;
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly subagentWatch?: SubagentWatchCoordinator;
}): {
  readonly subagentState: ReturnType<
    ReturnType<typeof createSubagentReader>["getSnapshot"]
  >;
  readonly childReader: ReturnType<typeof createSubagentConversationReader>;
  readonly childReadingCache: SubagentReadingCache;
  readonly childState: ReturnType<
    ReturnType<typeof createSubagentConversationReader>["getSnapshot"]
  >;
  readonly viewingSubagent: boolean;
  readonly approvalDialogVisible: boolean;
  readonly childExpanded: boolean;
  readonly setChildExpanded: (expanded: boolean) => void;
  readonly childAnchorToken: number;
  readonly openChild: (
    execution: Parameters<
      ReturnType<typeof createSubagentConversationReader>["select"]
    >[0],
    trigger: HTMLButtonElement,
  ) => void;
  readonly closeChild: () => void;
} {
  const { client, view, contentRef, subagentWatch } = input;
  const sessionId = view.activeSession?.id;
  const subagents = useMemo(
    () => createSubagentReader(client, sessionId ?? ""),
    [client, sessionId],
  );
  const subagentState = useSyncExternalStore(
    subagents.subscribe,
    subagents.getSnapshot,
  );
  useEffect(() => {
    if (!sessionId) return;
    void subagents.refresh();
    const timer = setInterval(() => {
      void subagents.refresh();
    }, 1000);
    return (): void => {
      clearInterval(timer);
      subagents.dispose();
    };
  }, [subagents, sessionId]);
  const childReader = useMemo(
    () => createSubagentConversationReader(client, sessionId ?? ""),
    [client, sessionId],
  );
  const childReadingCache = useMemo<SubagentReadingCache>(
    () => new Map(),
    [childReader],
  );
  const childState = useSyncExternalStore(
    useCallback(
      (listener: () => void) => childReader.subscribe(listener),
      [childReader],
    ),
    childReader.getSnapshot,
  );
  useEffect(
    () => (): void => {
      childReader.dispose();
    },
    [childReader],
  );
  const viewingSubagent = childState.selected !== undefined;
  const approvalDialogVisible =
    !viewingSubagent && view.pendingPermissions.length > 0;
  const [childExpanded, setChildExpanded] = useState(false);
  const [childAnchorToken, setChildAnchorToken] = useState(0);
  const childTrigger = useRef<HTMLButtonElement | null>(null);

  const openChild = useCallback(
    (
      execution: Parameters<typeof childReader.select>[0],
      trigger: HTMLButtonElement,
    ): void => {
      childTrigger.current = trigger;
      setChildAnchorToken((value) => value + 1);
      subagentWatch?.claim("sheet");
      void childReader.select(execution);
    },
    [childReader, subagentWatch],
  );
  // The right panel opened a detail and took the one watch: close the sheet
  // rather than leave it showing a conversation that no longer updates.
  useEffect(
    () =>
      subagentWatch?.subscribe(() => {
        if (subagentWatch.owner() === "sheet") return;
        if (childReader.getSnapshot().selected === undefined) return;
        childReader.close();
        setChildExpanded(false);
      }),
    [childReader, subagentWatch],
  );

  const closeChild = useCallback(() => {
    childReader.close();
    setChildExpanded(false);
    requestAnimationFrame(() => {
      const approvalTitle = contentRef.current?.querySelector<HTMLElement>(
        `${APPROVAL_PANEL_SELECTOR} h2`,
      );
      if (approvalTitle) {
        approvalTitle.focus({ preventScroll: true });
        return;
      }
      const target = childTrigger.current?.isConnected
        ? childTrigger.current
        : contentRef.current?.querySelector<HTMLElement>(
            ".ohb-root-conversation",
          );
      target?.focus({ preventScroll: true });
    });
  }, [childReader, contentRef]);

  const composerFocusBeforeApproval = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const rememberComposerFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest(APPROVAL_PANEL_SELECTOR)
      )
        return;
      composerFocusBeforeApproval.current =
        target instanceof HTMLTextAreaElement &&
        target.closest(".ohb-root-composer")
          ? target
          : null;
    };
    document.addEventListener("focusin", rememberComposerFocus);
    return (): void => {
      document.removeEventListener("focusin", rememberComposerFocus);
    };
  }, []);

  const previousApprovalVisible = useRef(false);
  useLayoutEffect(() => {
    const wasVisible = previousApprovalVisible.current;
    previousApprovalVisible.current = approvalDialogVisible;
    if (approvalDialogVisible || !wasVisible) return;
    const restore = composerFocusBeforeApproval.current;
    composerFocusBeforeApproval.current = null;
    if (!viewingSubagent && restore?.isConnected)
      restore.focus({ preventScroll: true });
  }, [approvalDialogVisible, viewingSubagent]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !approvalDialogVisible) return;
    const card = content.querySelector<HTMLElement>(APPROVAL_PANEL_SELECTOR);
    if (!card) return;
    const measure = (): void => {
      content.style.setProperty(
        "--approval-space",
        `${String(card.getBoundingClientRect().height + 24)}px`,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(card);
    return (): void => {
      observer?.disconnect();
      content.style.removeProperty("--approval-space");
    };
  }, [approvalDialogVisible, contentRef]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !viewingSubagent || childExpanded) return;
    const composer = content.querySelector<HTMLElement>(".ohb-composer-input");
    const measure = (): void => {
      if (!composer) return;
      const rect = content.getBoundingClientRect();
      const geometry = subagentSheetGeometry(
        rect,
        composer.getBoundingClientRect(),
        rect.top,
        window.innerWidth <= 720,
      );
      for (const [key, value] of Object.entries(geometry))
        content.style.setProperty(`--child-${key}`, `${String(value)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    if (composer) observer.observe(composer);
    return (): void => {
      observer.disconnect();
    };
  }, [viewingSubagent, childExpanded, contentRef]);

  return {
    subagentState,
    childReader,
    childReadingCache,
    childState,
    viewingSubagent,
    approvalDialogVisible,
    childExpanded,
    setChildExpanded,
    childAnchorToken,
    openChild,
    closeChild,
  };
}
