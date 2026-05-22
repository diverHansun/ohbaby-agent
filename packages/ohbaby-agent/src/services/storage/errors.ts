export class NotFoundError extends Error {
  constructor(readonly key: readonly string[]) {
    super(`Storage object not found: ${key.join("/")}`);
    this.name = "NotFoundError";
  }
}

export class InvalidStorageKeyError extends Error {
  constructor(
    readonly key: readonly string[],
    reason: string,
  ) {
    super(`Invalid storage key ${JSON.stringify(key)}: ${reason}`);
    this.name = "InvalidStorageKeyError";
  }
}

export class StorageWriteError extends Error {
  constructor(
    readonly key: readonly string[],
    readonly originalError: unknown,
  ) {
    super(`Failed to write storage object: ${key.join("/")}`);
    this.name = "StorageWriteError";
  }
}
