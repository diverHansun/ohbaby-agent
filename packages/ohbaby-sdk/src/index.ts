export type UiRunStatus =
  | { kind: 'idle' }
  | { kind: 'running'; runId: string; title?: string }
  | { kind: 'waiting-for-permission'; requestId: string }
  | { kind: 'error'; message: string; recoverable: boolean };

export interface UiSnapshot {
  readonly sessions: readonly UiSession[];
  readonly activeSessionId: string | null;
  readonly runs: readonly UiRun[];
  readonly permissions: readonly UiPermissionRequest[];
  readonly status: UiRunStatus;
}

export interface UiSession {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly UiMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UiRun {
  readonly id: string;
  readonly sessionId: string;
  readonly status: UiRunStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface UiMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly parts: readonly UiMessagePart[];
  readonly createdAt: string;
}

export type UiMessagePart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: UiToolCall }
  | { readonly type: 'tool-result'; readonly result: UiToolResult };

export interface UiToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface UiToolResult {
  readonly callId: string;
  readonly output: string;
  readonly error?: string;
}

export interface UiPermissionRequest {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly description: string;
  readonly choices: readonly UiPermissionChoice[];
}

export interface UiPermissionChoice {
  readonly id: string;
  readonly label: string;
  readonly intent: 'allow' | 'deny' | 'abort';
}

export interface UiPermissionResponse {
  readonly choiceId: string;
  readonly remember?: boolean;
}

export type UiEvent =
  | { readonly type: 'snapshot'; readonly snapshot: UiSnapshot }
  | { readonly type: 'session.updated'; readonly session: UiSession }
  | { readonly type: 'message.appended'; readonly sessionId: string; readonly message: UiMessage }
  | { readonly type: 'run.updated'; readonly run: UiRun }
  | { readonly type: 'permission.requested'; readonly request: UiPermissionRequest }
  | { readonly type: 'permission.resolved'; readonly requestId: string }
  | { readonly type: 'status.updated'; readonly status: UiRunStatus };

export interface SubmitPromptOptions {
  readonly sessionId?: string;
}

export interface UiCommand {
  readonly name: string;
  readonly args?: readonly string[];
}

export type UiEventHandler = (event: UiEvent) => void;
export type UiUnsubscribe = () => void;

export interface UiBackendClient {
  getSnapshot(): Promise<UiSnapshot>;
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
  executeCommand(command: UiCommand): Promise<void>;
  respondPermission(requestId: string, response: UiPermissionResponse): Promise<void>;
  abortRun(runId?: string): Promise<void>;
}

