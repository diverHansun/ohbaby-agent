import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCommand,
  UiEventHandler,
  UiPermissionResponse,
  UiSnapshot,
} from 'ohbaby-sdk';

const EMPTY_SNAPSHOT: UiSnapshot = {
  sessions: [],
  activeSessionId: null,
  runs: [],
  permissions: [],
  status: {
    kind: 'idle',
  },
};

export function createInProcessUiBackendClient(
  snapshot: UiSnapshot = EMPTY_SNAPSHOT,
): UiBackendClient {
  const handlers = new Set<UiEventHandler>();

  return {
    getSnapshot(): Promise<UiSnapshot> {
      return Promise.resolve(snapshot);
    },

    subscribeEvents(handler: UiEventHandler) {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },

    submitPrompt(_text: string, _options?: SubmitPromptOptions): Promise<void> {
      return Promise.resolve();
    },

    executeCommand(_command: UiCommand): Promise<void> {
      return Promise.resolve();
    },

    respondPermission(
      _requestId: string,
      _response: UiPermissionResponse,
    ): Promise<void> {
      return Promise.resolve();
    },

    abortRun(_runId?: string): Promise<void> {
      return Promise.resolve();
    },
  };
}
