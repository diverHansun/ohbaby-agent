import type {
  UiEvent,
  UiEventHandler,
  UiNotice,
  UiSnapshot,
} from "ohbaby-sdk";
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

  async publishSnapshotReplacement(
    readSnapshot: () => Promise<UiSnapshot>,
  ): Promise<void> {
    this.publish({
      snapshot: await readSnapshot(),
      timestamp: this.options.nowMs(),
      type: "snapshot.replaced",
    });
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
