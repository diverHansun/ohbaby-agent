import { createContext } from "react";
import type { ReactNode } from "react";
import type {
  UiMessage,
  UiSubagentExecution,
  UiToolCall,
  UiToolResult,
} from "ohbaby-sdk";

/** Optional presentation shared by the normal and read-only transcripts. */
export const ConversationPresentation = createContext<{
  readonly executions?: readonly UiSubagentExecution[];
  readonly fromParent?: boolean;
  readonly tools?: Map<string, boolean>;
  readonly renderTool?: (
    message: UiMessage,
    call: UiToolCall,
    result: UiToolResult | undefined,
  ) => ReactNode;
}>({});
