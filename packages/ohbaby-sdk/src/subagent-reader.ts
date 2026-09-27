import type {
  UiSubagentReadClient,
  UiSubagentExecutionList,
  UiSubagentExecutionView,
} from "./subagent.js";

export interface UiSubagentReaderState {
  readonly list?: UiSubagentExecutionList;
  readonly view?: UiSubagentExecutionView;
  readonly selectedId?: string;
  readonly loading: boolean;
  readonly error?: string;
}
/** A cancellable read-only projection shared by browser and terminal surfaces. */
export function createSubagentReader(
  client: Partial<UiSubagentReadClient>,
  rootSessionId: string,
) {
  let state: UiSubagentReaderState = { loading: false };
  let disposed = false;
  let generation = 0;
  let pending: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<UiSubagentReaderState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const read = async (
    kind: "refresh" | "listMore" | "viewMore" = "refresh",
  ): Promise<void> => {
    if (
      disposed ||
      !client.listSubagentExecutions ||
      !client.getSubagentExecutionView
    )
      return;
    if (pending && kind === "refresh") return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const ticket = generation;
    const selectedId = state.selectedId;
    publish({ loading: true, error: undefined });
    try {
      const list =
        kind === "viewMore"
          ? state.list
          : await client.listSubagentExecutions({
              rootSessionId,
              signal: controller.signal,
              before: kind === "listMore" ? state.list?.before : undefined,
            });
      const view = selectedId
        ? await client.getSubagentExecutionView({
            rootSessionId,
            executionId: selectedId,
            signal: controller.signal,
            before:
              kind === "viewMore" ? state.view?.history.before : undefined,
          })
        : undefined;
      if (ticket !== generation || controller.signal.aborted) return;
      const mergedList =
        list &&
        state.list &&
        (kind !== "refresh" ||
          list.executions.some((fresh) =>
            state.list?.executions.some(
              (old) => old.executionId === fresh.executionId,
            ),
          ))
          ? {
              ...list,
              executions: [
                ...new Map(
                  (kind === "listMore"
                    ? [...state.list.executions, ...list.executions]
                    : [
                        ...list.executions,
                        ...state.list.executions.filter(
                          (old) =>
                            !list.executions.some(
                              (fresh) => fresh.executionId === old.executionId,
                            ),
                        ),
                      ]
                  ).map((item) => [item.executionId, item]),
                ).values(),
              ],
              ...(kind === "refresh" &&
              state.list.executions.length > list.executions.length
                ? { before: state.list.before, hasMore: state.list.hasMore }
                : {}),
            }
          : list;
      const old = state.view;
      const sameGeneration =
        old?.version?.runtimeEpoch === view?.version?.runtimeEpoch &&
        old?.version?.viewGeneration === view?.version?.viewGeneration;
      const mergedView =
        view &&
        old &&
        sameGeneration &&
        (kind === "viewMore" ||
          view.messages.some((fresh) =>
            old.messages.some((previous) => previous.id === fresh.id),
          ))
          ? {
              ...view,
              messages: [
                ...new Map(
                  [...old.messages, ...view.messages].map((message) => [
                    message.id,
                    message,
                  ]),
                ).values(),
              ].sort(
                (a, b) =>
                  a.createdAt.localeCompare(b.createdAt) ||
                  a.id.localeCompare(b.id),
              ),
              history: kind === "viewMore" ? view.history : old.history,
            }
          : view;
      publish({ list: mergedList, view: mergedView, loading: false });
    } catch (error) {
      if (ticket === generation && !controller.signal.aborted)
        publish({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pending === controller) pending = undefined;
    }
  };
  return {
    getSnapshot: (): UiSubagentReaderState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: (): Promise<void> => {
      disposed = false;
      return read();
    },
    loadMore: (): Promise<void> =>
      read(state.selectedId ? "viewMore" : "listMore"),
    select(executionId?: string): void {
      generation += 1;
      pending?.abort();
      pending = undefined;
      publish({
        selectedId: executionId,
        view: undefined,
        error: undefined,
        loading: false,
      });
      void read();
    },
    dispose(): void {
      disposed = true;
      generation += 1;
      pending?.abort();
      listeners.clear();
    },
  };
}
