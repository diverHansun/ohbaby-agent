import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("BEGIN IMMEDIATE");
process.send({ locked: true });
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  process.disconnect();
}, Number(process.argv[3]));
