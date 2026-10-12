import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const destination = new URL("../dist/assets/", import.meta.url);
await mkdir(destination, { recursive: true });
const licenses = [];
for (const grammar of ["bash", "powershell"]) {
  const asset = require.resolve(
    `tree-sitter-${grammar}/tree-sitter-${grammar}.wasm`,
  );
  await copyFile(asset, new URL(`tree-sitter-${grammar}.wasm`, destination));
  licenses.push(
    `tree-sitter-${grammar}\n${await readFile(join(dirname(asset), "LICENSE"), "utf8")}`,
  );
}
await writeFile(
  new URL("SHELL-GRAMMAR-LICENSES.txt", destination),
  licenses.join("\n\n"),
);
