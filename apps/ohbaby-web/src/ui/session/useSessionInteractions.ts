import { createSubagentReader, type UiBackendClient } from "ohbaby-sdk";
import type { RefObject } from "react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ViewModel } from "./selectors.js";

/** The approval panel; its height reserves space at the bottom of the stream. */
export const APPROVAL_PANEL_SELECTOR = ".ohb-approval-panel";

/**
 * The execution records behind the chat's delegation entries, the approval
 * panel's visibility, and the focus and layout bookkeeping between the
 * conversation and the approval panel. Subagent conversations are read in the
 * right panel (improve-4), so nothing here hides the approval or locks input.
 */
export function useSessionInteractions(input: {
  readonly client: UiBackendClient;
  readonly view: ViewModel;
  readonly contentRef: RefObject<HTMLDivElement | null>;
}): {
  readonly subagentState: ReturnType<
    ReturnType<typeof createSubagentReader>["getSnapshot"]
  >;
  readonly approvalDialogVisible: boolean;
} {
  const { client, view, contentRef } = input;
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
  const approvalDialogVisible = view.pendingPermissions.length > 0;

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
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, [approvalDialogVisible]);

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

  return { subagentState, approvalDialogVisible };
}
