import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import {
  createSqliteGoalPersistence,
  InMemoryGoalPersistence,
} from "./persistence.js";
import type { GoalPersistencePort } from "./types.js";

describe("goal persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "goals-db-"));
    initDatabase({ dbPath: join(dir, "test.db") });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { force: true, recursive: true });
  });

  const suite = (name: string, make: () => GoalPersistencePort): void => {
    describe(name, () => {
      it("appends records with increasing seq and lists them in order", async () => {
        const persistence = make();
        await persistence.append("s1", {
          goalId: "g1",
          objective: "fix tests",
          type: "create",
        });
        await persistence.append("s1", {
          goalId: "g1",
          reason: "interrupted",
          status: "paused",
          type: "update",
        });
        const records = await persistence.list("s1");
        expect(records.map((record) => record.seq)).toEqual([1, 2]);
        expect(records[0]).toMatchObject({
          goalId: "g1",
          sessionId: "s1",
          type: "create",
        });
        expect(records[1]).toMatchObject({ status: "paused", type: "update" });
      });

      it("isolates sessions", async () => {
        const persistence = make();
        await persistence.append("s1", {
          goalId: "g1",
          objective: "a",
          type: "create",
        });
        await persistence.append("s2", {
          goalId: "g2",
          objective: "b",
          type: "create",
        });
        expect(await persistence.list("s1")).toHaveLength(1);
        expect(await persistence.list("s2")).toHaveLength(1);
      });

      it("returns empty list for unknown session", async () => {
        expect(await make().list("nope")).toEqual([]);
      });
    });
  };

  suite("sqlite", () => createSqliteGoalPersistence(getDatabase()));
  suite("in-memory", () => new InMemoryGoalPersistence());
});
