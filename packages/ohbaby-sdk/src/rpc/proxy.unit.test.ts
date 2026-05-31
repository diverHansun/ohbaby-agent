import { describe, expect, it } from "vitest";
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

describe("createRPC", () => {
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

  it("passes callback API methods through without wrapping them in RPC", () => {
    const rpc = createRPC<DemoAPI>();
    const unsubscribe = (): void => undefined;
    const subscribeEvents = (): (() => void) => unsubscribe;

    const proxy = rpc.createProxy({ subscribeEvents });

    expect(
      (proxy as unknown as DemoCallbacks).subscribeEvents(() => undefined),
    ).toBe(unsubscribe);
  });

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
});
