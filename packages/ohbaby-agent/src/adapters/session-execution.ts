/** Occupancy only: callers serialize check/persist/reserve in the session owner. */
export class SessionExecutionGate {
  private readonly holders = new Map<string, symbol>();
  private readonly listeners = new Map<string, Set<() => void>>();

  isHeld(sessionId: string): boolean {
    return this.holders.has(sessionId);
  }

  reserve(sessionId: string, token: symbol): boolean {
    if (this.holders.has(sessionId)) return false;
    this.holders.set(sessionId, token);
    return true;
  }

  release(token: symbol): void {
    for (const [sessionId, holder] of this.holders) {
      if (holder !== token) continue;
      this.holders.delete(sessionId);
      this.notify(sessionId);
      return;
    }
  }

  subscribe(sessionId: string, wake: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(wake);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(wake);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  close(): void {
    for (const sessionId of this.listeners.keys()) this.notify(sessionId);
    this.listeners.clear();
  }

  notify(sessionId: string): void {
    for (const wake of [...(this.listeners.get(sessionId) ?? [])]) wake();
  }
}
