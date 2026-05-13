export interface RingBufferEntry<T> {
  readonly id: number;
  readonly data: T;
}

export class RingBuffer<T> {
  private readonly entries: RingBufferEntry<T>[] = [];
  private nextId = 1;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("RingBuffer capacity must be a positive integer");
    }
  }

  get oldestId(): number {
    return this.entries[0]?.id ?? this.latestId + 1;
  }

  get latestId(): number {
    return this.nextId - 1;
  }

  append(data: T): RingBufferEntry<T> {
    const entry = {
      id: this.nextId,
      data,
    };
    this.nextId += 1;

    if (this.entries.length === this.capacity) {
      this.entries.shift();
    }
    this.entries.push(entry);

    return entry;
  }

  getRange(fromId: number, toId: number): RingBufferEntry<T>[] {
    return this.entries.filter(
      (entry) => entry.id >= fromId && entry.id <= toId,
    );
  }

  isContinuous(lastEventId: number): boolean {
    return lastEventId >= this.oldestId - 1 && lastEventId <= this.latestId;
  }
}
