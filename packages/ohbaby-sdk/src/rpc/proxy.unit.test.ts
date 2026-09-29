import { describe, expect, it, vi } from "vitest";
import { createRPC } from "./proxy.js";

interface DemoAPI {
  readonly readState: () => Promise<{ readonly nested: { value: string } }>;
  readonly mutateInput: (input: {
    readonly nested: { value: string };
  }) => Promise<{ readonly nested: { value: string } }>;
  readonly fail: () => Promise<void>;
  readonly slow: (signal?: AbortSignal) => Promise<string>;
}

interface DemoCallbacks {
  readonly subscribeEvents: (handler: (value: string) => void) => () => void;
}

interface PromptWaitAPI {
  readonly submitPromptAndWait: (
    text: string,
    options?: { readonly sessionId?: string; readonly signal?: AbortSignal },
  ) => Promise<string>;
  readonly waitForPrompt: (
    promptId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<string>;
}

interface ReceiverAPI {
  readonly readValue: () => Promise<string>;
}

describe("createRPC", () => {
  it("preserves the connected implementation as the method receiver", async () => {
    class ReceiverImplementation implements ReceiverAPI {
      private readonly value = "receiver state";

      readValue(): Promise<string> {
        return Promise.resolve(this.value);
      }
    }

    const rpc = createRPC<ReceiverAPI>();
    rpc.connectImpl(new ReceiverImplementation());
    const proxy = rpc.createProxy({});

    await expect(proxy.readValue()).resolves.toBe("receiver state");
  });

  it("serializes calls and results across the boundary", async () => {
    const rpc = createRPC<DemoAPI>();
    const state = { nested: { value: "backend" } };
    let receivedInput: { nested: { value: string } } | undefined;
    rpc.connectImpl({
      fail() {
        return Promise.reject(new Error("unused"));
      },
      mutateInput(input) {
        receivedInput = input;
        input.nested.value = "changed-by-backend";
        return Promise.resolve(input);
      },
      readState() {
        return Promise.resolve(state);
      },
      slow() {
        return Promise.resolve("ok");
      },
    });
    const proxy = rpc.createProxy({
      subscribeEvents(): () => void {
        return () => undefined;
      },
    });

    const result = await proxy.readState();
    result.nested.value = "changed-by-frontend";
    expect(state.nested.value).toBe("backend");

    const input = { nested: { value: "frontend" } };
    const mutated = await proxy.mutateInput(input);
    expect(input.nested.value).toBe("frontend");
    expect(receivedInput?.nested.value).toBe("changed-by-backend");
    expect(mutated.nested.value).toBe("changed-by-backend");
  });

  it("rethrows backend errors as Error objects", async () => {
    const rpc = createRPC<DemoAPI>();
    rpc.connectImpl({
      fail() {
        return Promise.reject(new TypeError("backend exploded"));
      },
      mutateInput(input) {
        return Promise.resolve(input);
      },
      readState() {
        return Promise.resolve({ nested: { value: "backend" } });
      },
      slow() {
        return Promise.resolve("ok");
      },
    });
    const proxy = rpc.createProxy({
      subscribeEvents(): () => void {
        return () => undefined;
      },
    });

    await expect(proxy.fail()).rejects.toMatchObject({
      message: "backend exploded",
      name: "TypeError",
    });
  });

  it("preserves only stable error codes across the boundary", async () => {
    const createFailingProxy = (code: unknown): Pick<DemoAPI, "fail"> => {
      const rpc = createRPC<Pick<DemoAPI, "fail">>();
      rpc.connectImpl({
        fail() {
          return Promise.reject(
            Object.assign(new Error("backend exploded"), { code }),
          );
        },
      });
      return rpc.createProxy({});
    };

    await expect(
      createFailingProxy("STABLE_CODE").fail(),
    ).rejects.toMatchObject({
      code: "STABLE_CODE",
      message: "backend exploded",
    });
    await expect(
      createFailingProxy("unsafe\ncode").fail(),
    ).rejects.not.toHaveProperty("code");
    await expect(
      createFailingProxy("A".repeat(65)).fail(),
    ).rejects.not.toHaveProperty("code");
  });

  it("passes callback API methods through without wrapping them in RPC", () => {
    const rpc = createRPC<DemoAPI>();
    const unsubscribe = (): void => undefined;
    const subscribeEvents = (): (() => void) => unsubscribe;

    const proxy = rpc.createProxy({ subscribeEvents });

    expect(
      (proxy as unknown as DemoCallbacks).subscribeEvents(() => undefined),
    ).toBe(unsubscribe);
  });

  it("keeps approval subscriptions synchronous and preserves callbacks and receiver", () => {
    const handler = (): void => undefined;
    const onError = (): void => undefined;
    const unsubscribe = (): void => undefined;
    const impl = {
      value: "backend",
      subscribePermissionEvents(
        received: typeof handler,
        error: typeof onError,
      ): () => void {
        expect(this.value).toBe("backend");
        expect(received).toBe(handler);
        expect(error).toBe(onError);
        return unsubscribe;
      },
    };
    const rpc = createRPC<typeof impl>();
    rpc.connectImpl(impl);
    const proxy = rpc.createProxy({});
    const result = proxy.subscribePermissionEvents(handler, onError);
    if (result instanceof Promise) void result.catch(() => undefined);
    expect(result).toBe(unsubscribe);
  });

  it("passes approval query cancellation out of band at argument zero", async () => {
    let receivedSignal: AbortSignal | undefined;
    const rpc = createRPC<{
      getPermissionSnapshot(input: {
        rootSessionId: string;
        signal?: AbortSignal;
      }): Promise<string>;
    }>();
    rpc.connectImpl({
      getPermissionSnapshot(input) {
        receivedSignal = input.signal;
        expect(input.rootSessionId).toBe("root");
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const pending = rpc.createProxy({}).getPermissionSnapshot({
      rootSessionId: "root",
      signal: controller.signal,
    });
    const rejected = pending.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it.each([
    "getSessionView",
    "getSessionHistory",
    "getSessionControl",
    "getPromptReceipt",
    "listSubagentExecutions",
    "getSubagentExecutionView",
  ] as const)(
    "preserves %s cancellation across the JSON proxy boundary",
    async (method) => {
      let receivedSignal: AbortSignal | undefined;
      const implementation = {
        [method]: (input: {
          sessionId: string;
          signal?: AbortSignal;
        }): Promise<string> => {
          receivedSignal = input.signal;
          input.signal?.throwIfAborted();
          return new Promise((_resolve, reject) =>
            input.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("backend cancelled"));
              },
              { once: true },
            ),
          );
        },
      };
      const rpc = createRPC<typeof implementation>();
      rpc.connectImpl(implementation);
      const controller = new AbortController();
      const outcome = rpc
        .createProxy({})
        [method]({ sessionId: "root", signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.waitFor(() => {
        expect(receivedSignal).toBeDefined();
      });
      controller.abort();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(receivedSignal).toBe(controller.signal);
    },
  );

  it("rejects a pending call when its AbortSignal is aborted", async () => {
    const rpc = createRPC<DemoAPI>();
    rpc.connectImpl({
      fail() {
        return Promise.reject(new Error("unused"));
      },
      mutateInput(input) {
        return Promise.resolve(input);
      },
      readState() {
        return Promise.resolve({ nested: { value: "backend" } });
      },
      async slow() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "too late";
      },
    });
    const proxy = rpc.createProxy({
      subscribeEvents(): () => void {
        return () => undefined;
      },
    });
    const controller = new AbortController();

    const pending = proxy.slow(controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it.each(["waitForPrompt", "submitPromptAndWait"] as const)(
    "passes the nested signal out of band so %s cleans its backend waiter",
    async (method) => {
      const rpc = createRPC<PromptWaitAPI>();
      let backendAborted = false;
      let receivedSessionId: string | undefined;
      const waitForAbort = (signal: AbortSignal | undefined): Promise<string> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              backendAborted = true;
              const error = new Error("backend waiter aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      rpc.connectImpl({
        submitPromptAndWait(_text, options) {
          receivedSessionId = options?.sessionId;
          return waitForAbort(options?.signal);
        },
        waitForPrompt(_promptId, options) {
          return waitForAbort(options?.signal);
        },
      });
      const proxy = rpc.createProxy({});
      const controller = new AbortController();

      const pending =
        method === "waitForPrompt"
          ? proxy.waitForPrompt("prompt_1", { signal: controller.signal })
          : proxy.submitPromptAndWait("hello", {
              sessionId: "session_1",
              signal: controller.signal,
            });
      const rejection = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();

      await rejection;
      expect(backendAborted).toBe(true);
      if (method === "submitPromptAndWait") {
        expect(receivedSessionId).toBe("session_1");
      }
    },
  );
});
