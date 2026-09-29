/** Prepared runtime observations changed before any provider work was admitted. */
export class RuntimeInputSnapshotChangedError extends Error {
  constructor() {
    super("Runtime input snapshot changed before provider admission");
    this.name = "RuntimeInputSnapshotChangedError";
  }
}
export function isRuntimeInputSnapshotChanged(error: unknown): boolean {
  return (
    error instanceof RuntimeInputSnapshotChangedError ||
    (error instanceof Error &&
      error.cause instanceof RuntimeInputSnapshotChangedError)
  );
}
