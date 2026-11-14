import { once } from "node:events";
import { NodeSqliteConnection } from "../../services/database/connection.js";
import { DatabaseShellJobStore } from "../store.js";
import { shellJobFixture } from "./shell-job.js";

const dbPath = process.argv[2];
const actor = process.argv[3];
if (!dbPath || !actor || !process.send)
  throw new Error("Missing worker arguments or IPC");
const db = new NodeSqliteConnection(dbPath);
db.exec("PRAGMA busy_timeout = 0");
try {
  const store = new DatabaseShellJobStore({ db });
  process.send({ ready: true });
  await once(process, "message");
  let accepted = 0;
  for (let index = 0; index < 4; index++) {
    try {
      await store.insert(
        shellJobFixture({ jobId: `${actor}-${String(index)}` }),
        { maxBackgroundJobs: 3 },
      );
      accepted++;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "SHELL_JOB_CAPACITY_LIMIT"
      )
        throw error;
    }
  }
  process.send({ accepted });
} finally {
  db.close();
  process.disconnect();
}
