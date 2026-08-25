export interface ScopedExclusiveLane {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Serializes durable Context mutations per scope without coupling sibling
 * scopes to a session-wide lock.
 */
export function createScopedExclusiveLane(): ScopedExclusiveLane {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release = (): void => {
        throw new Error("Scoped lane release was not initialized");
      };
      const reservation = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => reservation);
      tails.set(key, tail);

      await previous.catch(() => undefined);
      try {
        return await operation();
      } finally {
        release();
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    },
  };
}
