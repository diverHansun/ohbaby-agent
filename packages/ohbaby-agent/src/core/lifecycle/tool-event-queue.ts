import type { LifecycleEvent } from "./types.js";

type ToolBatchEvent = Extract<
  LifecycleEvent,
  { type: "tool:state" | "tool:result" }
>;

/** Only saved tool observations enter this batch-local, O(call count) queue. */
export class ToolBatchEventQueue {
  private readonly pending = new Map<string, ToolBatchEvent>();
  private readonly terminal = new Set<string>();
  private wake?: () => void;
  private closed = false;
  private failure?: Error;
  push(event: ToolBatchEvent): void {
    if (this.closed || this.terminal.has(event.callId)) return;
    if (event.type === "tool:result") this.terminal.add(event.callId);
    this.pending.set(event.callId, event);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.close();
  }
  async *events(): AsyncGenerator<ToolBatchEvent> {
    for (;;) {
      if (this.failure !== undefined) throw this.failure;
      const first = this.pending.entries().next();
      if (!first.done) {
        this.pending.delete(first.value[0]);
        yield first.value[1];
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
