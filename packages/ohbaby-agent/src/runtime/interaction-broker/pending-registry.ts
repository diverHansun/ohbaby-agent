import type { PendingInteraction, PendingInteractionSummary } from "./types.js";

export class PendingInteractionRegistry {
  private readonly pending = new Map<string, PendingInteraction>();

  add(entry: PendingInteraction): void {
    this.pending.set(entry.interactionId, entry);
  }

  take(interactionId: string): PendingInteraction | undefined {
    const entry = this.pending.get(interactionId);
    if (entry) {
      this.pending.delete(interactionId);
    }
    return entry;
  }

  takeByCommandRun(commandRunId: string): PendingInteraction[] {
    const entries = Array.from(this.pending.values()).filter(
      (entry) => entry.commandRunId === commandRunId,
    );
    for (const entry of entries) {
      this.pending.delete(entry.interactionId);
    }
    return entries;
  }

  takeAll(): PendingInteraction[] {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    return entries;
  }

  list(): PendingInteractionSummary[] {
    return Array.from(this.pending.values()).map((entry) => ({
      interactionId: entry.interactionId,
      commandRunId: entry.commandRunId,
      clientInvocationId: entry.clientInvocationId,
      sessionId: entry.sessionId,
      subject: entry.request.subject,
      createdAt: entry.createdAt,
    }));
  }
}
