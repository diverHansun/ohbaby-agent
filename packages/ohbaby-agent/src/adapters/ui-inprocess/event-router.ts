import type { UiEvent, UiEventHandler, UiNotice } from "ohbaby-sdk";
import type { BusUnsubscribe } from "../../bus/index.js";
import type { NoticeDraft } from "./types.js";

export interface InProcessEventRouterOptions {
  readonly createNotice: (notice: NoticeDraft) => UiNotice;
  readonly nowMs: () => number;
}

export class InProcessEventRouter {
  private readonly handlers = new Set<UiEventHandler>();
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(private readonly options: InProcessEventRouterOptions) {}

  publish(event: UiEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // UI event handlers are observers; they must not break backend state.
      }
    }
  }

  publishNotice(notice: NoticeDraft): void {
    this.publish({
      notice: this.options.createNotice(notice),
      timestamp: this.options.nowMs(),
      type: "notice.emitted",
    });
  }

  /** Critical projection delivery reports failure after all healthy observers run. */
  publishRecovery(event: UiEvent): void {
    let failure: unknown;
    let failed = false;
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        failed = true;
        failure = error;
        if (event.type === "session.unavailable") this.handlers.delete(handler);
      }
    }
    if (failed)
      throw failure instanceof Error
        ? failure
        : new Error("Session observer failed", { cause: failure });
  }

  subscribeEvents(handler: UiEventHandler): BusUnsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  addSubscriptions(...subscriptions: BusUnsubscribe[]): void {
    this.subscriptions.push(...subscriptions);
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) {
      unsubscribe();
    }
    this.handlers.clear();
  }
}
