interface SerializedError {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

const CALLBACK_KEYS = new Set<PropertyKey>(["subscribeEvents"]);

function boundaryDelay(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return {
    message: String(error),
    name: "Error",
  };
}

function deserializeError(payload: SerializedError): Error {
  const error = new Error(payload.message);
  error.name = payload.name;
  if (payload.stack !== undefined) {
    error.stack = payload.stack;
  }
  return error;
}

function abortError(): Error {
  const error = new Error("The RPC call was aborted");
  error.name = "AbortError";
  return error;
}

function firstAbortSignal(values: readonly unknown[]): AbortSignal | undefined {
  return values.find(isAbortSignal);
}

function stripAbortSignals(values: readonly unknown[]): readonly unknown[] {
  return values.map((value) => (isAbortSignal(value) ? undefined : value));
}

function jsonClone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

async function cloneAcrossBoundary<T>(value: T): Promise<T> {
  await boundaryDelay();
  return jsonClone(value);
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((_, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createRPC<API extends object>(): {
  readonly connectImpl: (impl: API) => void;
  readonly createProxy: <CallbackAPI extends object>(
    callbacks: CallbackAPI,
  ) => API & CallbackAPI;
} {
  let impl: API | undefined;

  async function call(
    methodName: PropertyKey,
    args: readonly unknown[],
  ): Promise<unknown> {
    if (impl === undefined) {
      throw new Error("RPC implementation has not been connected");
    }

    const method = (impl as Record<PropertyKey, unknown>)[methodName];
    if (typeof method !== "function") {
      throw new Error(`RPC method not found: ${String(methodName)}`);
    }

    const signal = firstAbortSignal(args);
    if (signal?.aborted) {
      throw abortError();
    }

    const work = (async (): Promise<unknown> => {
      const clonedArgs = await cloneAcrossBoundary(stripAbortSignals(args));
      try {
        return await cloneAcrossBoundary(
          await (method as (...input: readonly unknown[]) => unknown)(
            ...clonedArgs,
          ),
        );
      } catch (error) {
        throw deserializeError(
          await cloneAcrossBoundary(serializeError(error)),
        );
      }
    })();

    return signal === undefined
      ? work
      : Promise.race([work, abortPromise(signal)]);
  }

  return {
    connectImpl(nextImpl): void {
      impl = nextImpl;
    },
    createProxy<CallbackAPI extends object>(
      callbacks: CallbackAPI,
    ): API & CallbackAPI {
      return new Proxy(callbacks, {
        get(target, prop): unknown {
          if (CALLBACK_KEYS.has(prop) && prop in target) {
            return (target as Record<PropertyKey, unknown>)[prop];
          }
          if (typeof prop === "symbol") {
            return undefined;
          }
          return (...args: readonly unknown[]) => call(prop, args);
        },
      }) as API & CallbackAPI;
    },
  };
}
