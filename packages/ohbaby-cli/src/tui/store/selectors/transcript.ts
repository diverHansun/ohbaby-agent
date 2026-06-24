import type { UiMessage, UiNotice } from "ohbaby-sdk";
import type {
  TuiCommandNotice,
  TuiReasoningViewState,
  TuiStoreState,
} from "../snapshot.js";
import type { TranscriptItem } from "../transcript.js";

export interface TranscriptSplitSelection {
  readonly committedItems: readonly TranscriptItem[];
  readonly liveMessage: UiMessage | null;
}

export interface NoticeLaneState {
  readonly notices: readonly UiNotice[];
}

export interface CommandNoticeLaneState {
  readonly commandNotices: readonly TuiCommandNotice[];
}

export function selectCommittedItems(
  state: TuiStoreState,
): readonly TranscriptItem[] {
  return state.committedItems;
}

export function selectLiveMessage(state: TuiStoreState): UiMessage | null {
  return state.liveMessage;
}

export function selectLiveReasoning(
  state: TuiStoreState,
): TuiReasoningViewState | undefined {
  return state.liveMessage
    ? state.reasoningByMessageId[state.liveMessage.id]
    : undefined;
}

export function selectTranscriptSplit(
  state: TuiStoreState,
): TranscriptSplitSelection {
  return {
    committedItems: state.committedItems,
    liveMessage: state.liveMessage,
  };
}

export function selectNoticeLaneState(state: TuiStoreState): NoticeLaneState {
  return { notices: state.notices };
}

export function selectCommandNoticeLaneState(
  state: TuiStoreState,
): CommandNoticeLaneState {
  return { commandNotices: state.commandNotices };
}
