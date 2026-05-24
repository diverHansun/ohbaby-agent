import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { UiEvent } from "ohbaby-sdk";
import type { CommandToolSummary } from "../../commands/index.js";
import type { ChatCompletionMessage } from "../../core/llm-client/index.js";
import type { CompactResult } from "../../core/context/index.js";
import type { ToolSchedulerInstance } from "../../core/tool-scheduler/index.js";
import type { AgentManager } from "../../agents/index.js";
import type { RunLedger } from "../../runtime/run-ledger/index.js";
import type { RunManager } from "../../runtime/run-manager/index.js";
import type { StreamBridge } from "../../runtime/stream-bridge/index.js";

export type PublishUiEvent = (event: UiEvent) => void;

export interface UiRuntimeComposition {
  readonly agentManager: AgentManager;
  readonly runLedger: RunLedger;
  readonly runManager: RunManager;
  readonly streamBridge: StreamBridge;
  readonly toolScheduler: ToolSchedulerInstance;
  reserveRunId(runId?: string): string;
  setSessionWorkdir(sessionId: string, workdir: string): void;
  ensureSessionRecord(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title: string;
  }): Promise<void>;
  getOpenAiTools(input: {
    readonly agentName?: string;
    readonly isSubagent?: boolean;
  }): Promise<ChatCompletionCreateParams["tools"]>;
  buildPromptMessages(input: {
    readonly agentName: string;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): Promise<ChatCompletionMessage[]>;
  compactSession(input: {
    readonly force?: boolean;
    readonly isSubagent?: boolean;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): Promise<CompactResult>;
  listToolSummaries(input?: {
    readonly agentName?: string;
  }): Promise<readonly CommandToolSummary[]>;
  cancel(runId: string, reason?: string): void;
}
