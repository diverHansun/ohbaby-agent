/** Temporary display source. Protocol reasoning has a separate lifecycle owner. */
export interface ReasoningIdentity {
  readonly sessionId: string;
  readonly runId?: string;
  readonly contextScopeId?: string;
  readonly messageId: string;
  readonly partId: string;
  readonly metadata?: { readonly sourceOrder: number };
}
export type ReasoningEndReason = "normal" | "interrupted" | "failed";
export interface DisplayReasoningRecord extends ReasoningIdentity {
  readonly text: string;
  readonly endReason?: ReasoningEndReason;
  readonly saveState: "pending" | "saved" | "failed";
}
export interface DisplayReasoningChange {
  readonly kind: "updated" | "pending" | "saved" | "failed" | "missing";
  readonly part: DisplayReasoningRecord;
  readonly missingCount: number;
}
export interface DisplayReasoningOptions {
  readonly save: (part: DisplayReasoningRecord) => Promise<unknown>;
  /** Application short commit; failures never enter the model/tool retry chain. */
  readonly commit?: (change: DisplayReasoningChange) => void | Promise<void>;
  readonly onCommitError?: (sessionId: string, error: unknown) => void;
  readonly maxBytes?: number;
  readonly maxParts?: number;
}
interface Entry {
  part: DisplayReasoningRecord;
  attempts: number;
  ready: boolean;
  evicted: boolean;
  persisted: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class DisplayReasoningOwner {
  private readonly entries = new Map<string, Entry>();
  private readonly missing = new Map<string, number>();
  private writerEntry?: Entry;
  private disposed = false;
  private readonly ended: Entry[] = [];
  constructor(private readonly options: DisplayReasoningOptions) {}

  async update(identity: ReasoningIdentity, text: string): Promise<void> {
    if (this.disposed || !text) return;
    const old = this.entries.get(identity.partId);
    if (old?.part.endReason) return;
    const entry: Entry = old ?? {
      part: { ...identity, text, saveState: "pending" },
      attempts: 0,
      ready: false,
      evicted: false,
      persisted: false,
    };
    entry.part = { ...entry.part, text };
    this.entries.set(identity.partId, entry);
    await this.commit("updated", entry.part);
  }

  async finish(partId: string, endReason: ReasoningEndReason): Promise<void> {
    const entry = this.entries.get(partId);
    if (this.disposed || !entry || entry.part.endReason) return;
    entry.part = { ...entry.part, endReason, saveState: "pending" };
    this.ended.push(entry);
    await this.commit("pending", entry.part);
    entry.ready = true;
    await this.enforceBudget();
    this.pump();
  }

  snapshot(sessionId: string): {
    readonly parts: readonly DisplayReasoningRecord[];
    readonly missingCount: number;
  } {
    return {
      parts: [...this.entries.values()]
        .filter((entry) => entry.part.sessionId === sessionId)
        .map((entry) => entry.part),
      missingCount: this.missing.get(sessionId) ?? 0,
    };
  }

  /**
   * Includes an evicted write until its result callback settles. A versioned read
   * must overlay its accepted view (including any already committed saved part),
   * never attach current source text to a previously captured revision.
   */
  pendingPartIds(sessionId: string): readonly string[] {
    const ids = new Set(
      [...this.entries.values()]
        .filter((entry) => entry.part.sessionId === sessionId)
        .map((entry) => entry.part.partId),
    );
    if (this.writerEntry?.part.sessionId === sessionId)
      ids.add(this.writerEntry.part.partId);
    return [...ids];
  }

  /** Only explicit rebuild may install these confirmed durable values. */
  persistedParts(sessionId: string): readonly DisplayReasoningRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.persisted && entry.part.sessionId === sessionId)
      .map((entry) => ({ ...entry.part, saveState: "saved" }));
  }

  /** Called after the replacement view has atomically accepted its saved values. */
  acceptPersisted(partIds: readonly string[]): void {
    for (const partId of partIds) {
      const entry = this.entries.get(partId);
      if (!entry?.persisted) continue;
      this.entries.delete(partId);
      this.removeEnded(entry);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values())
      if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
    this.ended.length = 0;
    this.missing.clear();
    // An uncancellable in-flight writer retains its actual reference until settle.
  }

  private async commit(
    kind: DisplayReasoningChange["kind"],
    part: DisplayReasoningRecord,
  ): Promise<boolean> {
    try {
      await this.options.commit?.({
        kind,
        part,
        missingCount: this.missing.get(part.sessionId) ?? 0,
      });
      return true;
    } catch (error) {
      try {
        this.options.onCommitError?.(part.sessionId, error);
      } catch {
        /* Display reporting must not fail execution. */
      }
      return false;
    }
  }

  private async enforceBudget(): Promise<void> {
    const retained = (): Entry[] =>
      this.ended.filter(
        (entry) => !entry.evicted && this.entries.has(entry.part.partId),
      );
    const pending = retained();
    const missingChanges: DisplayReasoningRecord[] = [];
    let bytes = pending.reduce(
      (sum, entry) => sum + Buffer.byteLength(entry.part.text, "utf8"),
      0,
    );
    while (
      pending.length > (this.options.maxParts ?? 256) ||
      bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)
    ) {
      const entry = pending.shift();
      if (!entry) break;
      bytes -= Buffer.byteLength(entry.part.text, "utf8");
      entry.evicted = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(entry.part.partId);
      this.removeEnded(entry);
      // A failed projection cannot turn an acknowledged durable write into loss.
      // Its text can be read from the database on the next explicit rebuild.
      if (entry.persisted) continue;
      this.missing.set(
        entry.part.sessionId,
        (this.missing.get(entry.part.sessionId) ?? 0) + 1,
      );
      // Do not carry the evicted text into the projection or create another copy.
      missingChanges.push({ ...entry.part, text: "", saveState: "failed" });
    }
    // Select and remove entries without awaiting: concurrent session finalizers
    // must never account for the same eviction twice.
    pending.length = 0;
    await Promise.all(
      missingChanges.map((part) => this.commit("missing", part)),
    );
  }

  private removeEnded(entry: Entry): void {
    const index = this.ended.indexOf(entry);
    if (index !== -1) this.ended.splice(index, 1);
  }

  private pump(): void {
    if (this.disposed || this.writerEntry) return;
    const entry = this.ended.find(
      (candidate) =>
        candidate.ready && !candidate.evicted && candidate.attempts < 3,
    );
    if (!entry) return;
    this.writerEntry = entry;
    entry.ready = false;
    entry.attempts++;
    void this.write(entry).finally(() => {
      this.writerEntry = undefined;
      this.pump();
    });
  }

  private unavailable(entry: Entry): boolean {
    return this.disposed || entry.evicted;
  }

  private async write(entry: Entry): Promise<void> {
    try {
      await this.options.save(entry.part);
    } catch {
      if (this.unavailable(entry)) return;
      entry.part = { ...entry.part, saveState: "failed" };
      await this.commit("failed", entry.part);
      if (this.unavailable(entry)) return;
      if (entry.attempts < 3) {
        entry.timer = setTimeout(
          () => {
            entry.timer = undefined;
            entry.ready = true;
            this.pump();
          },
          entry.attempts === 1 ? 250 : 1000,
        );
        entry.timer.unref();
      }
      return;
    }
    if (this.disposed) return;
    entry.persisted = true;
    if (entry.evicted) {
      const count = this.missing.get(entry.part.sessionId) ?? 0;
      this.missing.set(entry.part.sessionId, Math.max(0, count - 1));
    }
    const accepted = await this.commit("saved", {
      ...entry.part,
      saveState: "saved",
    });
    if (accepted) {
      this.entries.delete(entry.part.partId);
      this.removeEnded(entry);
    }
  }
}
