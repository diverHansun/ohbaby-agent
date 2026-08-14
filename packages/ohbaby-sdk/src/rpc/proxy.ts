interface SerializedError {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

const CALLBACK_KEYS = new Set<PropertyKey>(["subscribeEvents"]);
const NESTED_SIGNAL_METHODS = new Set<PropertyKey>([
  "submitPromptAndWait",
  "waitForPrompt",
]);

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

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAbortSignals(values: readonly unknown[]): readonly unknown[] {
  return values.map((value) => (isAbortSignal(value) ? undefined : value));
}

interface ExtractedCallSignal {
  readonly args: readonly unknown[];
  readonly nestedOptionsIndex?: number;
  readonly signal?: AbortSignal;
}

function extractCallSignal(
  methodName: PropertyKey,
  args: readonly unknown[],
): ExtractedCallSignal {
  if (NESTED_SIGNAL_METHODS.has(methodName)) {
    const options = args[1];
    if (isRecord(options) && isAbortSignal(options.signal)) {
      const { signal, ...serializableOptions } = options;
      const serializableArgs = [...args];
      serializableArgs[1] = serializableOptions;
      return {
        args: serializableArgs,
        nestedOptionsIndex: 1,
        signal,
      };
    }
  }
  const signal = firstAbortSignal(args);
  return {
    args: stripAbortSignals(args),
    ...(signal === undefined ? {} : { signal }),
  };
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

function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
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

    const extracted = extractCallSignal(methodName, args);
    const { signal } = extracted;
    if (signal?.aborted) {
      throw abortError();
    }

    const work = (async (): Promise<unknown> => {
      const clonedArgs = [
        ...(await cloneAcrossBoundary(extracted.args)),
      ];
      if (
        signal !== undefined &&
        extracted.nestedOptionsIndex !== undefined
      ) {
        const clonedOptions = clonedArgs[extracted.nestedOptionsIndex];
        clonedArgs[extracted.nestedOptionsIndex] = {
          ...(isRecord(clonedOptions) ? clonedOptions : {}),
          signal,
        };
      }
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

    return signal === undefined ? work : raceWithAbort(work, signal);
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
