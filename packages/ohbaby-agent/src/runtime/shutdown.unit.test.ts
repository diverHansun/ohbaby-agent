import { expect, it } from "vitest";
import {
  collectCleanup,
  createShutdownOptions,
  withinShutdown,
} from "./shutdown.js";

it("starts every cleanup and reports both failures and work still pending at the shared deadline", async () => {
  const started: string[] = [];
  const options = createShutdownOptions(25);
  const result = await collectCleanup(options, {
    failed: () => {
      started.push("failed");
      throw new Error("save failed");
    },
    pending: () => {
      started.push("pending");
      return new Promise<void>(() => undefined);
    },
    complete: () => {
      started.push("complete");
    },
  });
  expect(started).toEqual(["failed", "pending", "complete"]);
  expect(result.status).toBe("unconfirmed");
  expect(result.errors.join(" ")).toContain("save failed");
  expect(result.errors.join(" ")).toContain("pending");
});

it("propagates an unconfirmed nested cleanup and never starts a step after the deadline", async () => {
  const result = await collectCleanup(createShutdownOptions(), {
    child: () => ({ status: "unconfirmed", errors: ["raw tool still active"] }),
  });
  expect(result).toEqual({
    status: "unconfirmed",
    errors: ["child: raw tool still active"],
  });
  let started = false;
  await expect(
    withinShutdown(createShutdownOptions(0), "final-save", () => {
      started = true;
      return Promise.resolve();
    }),
  ).rejects.toThrow("final-save");
  expect(started).toBe(false);
});
