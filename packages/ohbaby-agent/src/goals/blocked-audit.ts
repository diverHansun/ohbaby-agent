/** Process-local reports; admission turn numbers detect intervening silent runs. */
export class BlockedAudit {
  private last?: {
    runId: string;
    turnNumber: number;
    reason: string;
    count: number;
  };

  async report(
    runId: string,
    turnNumber: number,
    reason: string,
    block: () => Promise<unknown>,
  ): Promise<number> {
    const last = this.last;
    if (
      last !== undefined &&
      (last.runId === runId || turnNumber <= last.turnNumber)
    )
      return last.count;
    const normalized = reason.trim().toLowerCase();
    const count =
      last?.reason === normalized && turnNumber === last.turnNumber + 1
        ? last.count + 1
        : 1;
    // A failed third append leaves the second report intact and retryable.
    if (count >= 3) await block();
    this.last = { runId, turnNumber, reason: normalized, count };
    return count;
  }
}
