import type { SubmitPromptOptions } from "ohbaby-sdk";
import { PromptQueueController } from "../ui-prompt-queue.js";

export interface InProcessPromptControllerOptions {
  readonly isBusyError: (error: unknown) => boolean;
  readonly readActiveSessionId: () => Promise<string | null>;
  readonly retryDelayMs: number;
  readonly submitPromptInternal: (
    text: string,
    options?: SubmitPromptOptions,
  ) => Promise<void>;
}

export class InProcessPromptController {
  private readonly queue: PromptQueueController;

  constructor(private readonly options: InProcessPromptControllerOptions) {
    this.queue = new PromptQueueController({
      isBusyError: options.isBusyError,
      retryDelayMs: options.retryDelayMs,
      submit: async (item): Promise<void> => {
        let submitOptions = item.submitOptions;
        if (item.useActiveSessionOnDrain && item.sessionId === null) {
          const activeSessionId = await this.options.readActiveSessionId();
          if (activeSessionId) {
            submitOptions = {
              ...submitOptions,
              sessionId: activeSessionId,
            };
          }
        }
        await this.options.submitPromptInternal(item.text, submitOptions);
      },
    });
  }

  submitPrompt(
    text: string,
    submitOptions?: SubmitPromptOptions,
  ): Promise<void> {
    const useActiveSessionOnDrain =
      !submitOptions?.sessionId && this.queue.hasPendingWork();
    return this.queue.enqueue({
      sessionId: submitOptions?.sessionId ?? null,
      text,
      ...(useActiveSessionOnDrain ? { useActiveSessionOnDrain } : {}),
      ...(submitOptions === undefined ? {} : { submitOptions }),
    });
  }

  hasPendingWork(): boolean {
    return this.queue.hasPendingWork();
  }

  queuedCount(): number {
    return this.queue.size();
  }

  close(): void {
    this.queue.close();
  }
}
