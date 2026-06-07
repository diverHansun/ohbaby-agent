import type { UiMessage, UiNotice } from "ohbaby-sdk";
import type { TuiCommandNotice, TuiStoreState } from "../snapshot.js";

export interface TranscriptSplitSelection {
  readonly committedMessages: readonly UiMessage[];
  readonly liveMessage: UiMessage | null;
}

export interface NoticeLaneState {
  readonly notices: readonly UiNotice[];
}

export interface CommandNoticeLaneState {
  readonly commandNotices: readonly TuiCommandNotice[];
}

export function selectCommittedMessages(
  state: TuiStoreState,
): readonly UiMessage[] {
  return state.committedMessages;
}

export function selectLiveMessage(state: TuiStoreState): UiMessage | null {
  return state.liveMessage;
}

export function selectTranscriptSplit(
  state: TuiStoreState,
): TranscriptSplitSelection {
  return {
    committedMessages: state.committedMessages,
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
