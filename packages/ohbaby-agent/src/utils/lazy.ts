export function lazy<T>(init: () => T): () => T {
  let initialized = false;
  let value: T;

  return () => {
    if (!initialized) {
      value = init();
      initialized = true;
    }
    return value;
  };
}

export function lazyAsync<T>(init: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;

  return () => {
    promise ??= init();
    return promise;
  };
}
