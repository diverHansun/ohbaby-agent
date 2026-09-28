import { AsyncLocalStorage } from "node:async_hooks";

export interface DatabaseWriteBudget {
  /** Deadline while writes are active; idle time does not consume save allowance. */
  readonly deadlineAt: number;
}

interface BudgetClock {
  remainingMs: number;
  activeWrites: number;
  activeSince: number;
}

const clocks = new WeakMap<DatabaseWriteBudget, BudgetClock>();
const budgets = new AsyncLocalStorage<readonly DatabaseWriteBudget[]>();

function remaining(budget: DatabaseWriteBudget, at: number): number {
  const clock = clocks.get(budget);
  return clock
    ? clock.remainingMs - (clock.activeWrites ? at - clock.activeSince : 0)
    : budget.deadlineAt - at;
}

export class DatabaseWriteBudgetError extends Error {
  constructor() {
    super(
      "Critical-save attempt deadline reached; explicit recovery is required",
    );
    this.name = "DatabaseWriteBudgetError";
  }
}

export function createDatabaseWriteBudget(
  timeoutMs = 5000,
): DatabaseWriteBudget {
  const budget: DatabaseWriteBudget = {
    get deadlineAt(): number {
      const at = performance.now();
      return at + remaining(budget, at);
    },
  };
  clocks.set(budget, {
    remainingMs: timeoutMs,
    activeWrites: 0,
    activeSince: 0,
  });
  return budget;
}

export function getDatabaseWriteBudget(): DatabaseWriteBudget | undefined {
  return budgets.getStore()?.[0];
}

/** Nested child saves may tighten a budget, but can never extend their parent. */
export function withDatabaseWriteBudget<T>(
  budget: DatabaseWriteBudget,
  operation: () => T,
): T {
  const inherited = budgets.getStore() ?? [];
  return budgets.run(
    inherited.includes(budget) ? inherited : [...inherited, budget],
    operation,
  );
}

export function remainingDatabaseWriteBudget(): number {
  const at = performance.now();
  const available = Math.min(
    ...(budgets.getStore() ?? []).map((budget) => remaining(budget, at)),
  );
  if (available <= 0) throw new DatabaseWriteBudgetError();
  return available;
}

/** Count FIFO/SQLite/transaction time once, including concurrent child writes. */
export function activateDatabaseWriteBudget(): () => void {
  const active = (budgets.getStore() ?? []).flatMap((budget) => {
    const clock = clocks.get(budget);
    return clock ? [clock] : [];
  });
  const started = performance.now();
  for (const clock of active) {
    if (clock.activeWrites++ === 0) clock.activeSince = started;
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const ended = performance.now();
    for (const clock of active) {
      if (--clock.activeWrites === 0)
        clock.remainingMs -= ended - clock.activeSince;
    }
  };
}
