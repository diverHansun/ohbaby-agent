import { readFile } from "node:fs/promises";
const { controlUrl, authToken } = JSON.parse(
  await readFile(process.argv[2], "utf8"),
);
const response = await fetch(controlUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${authToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ command: process.argv[3] }),
  signal: AbortSignal.timeout(10000),
});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
