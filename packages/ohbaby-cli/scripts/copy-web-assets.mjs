import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "..", "..", "apps", "ohbaby-web", "dist");
const target = resolve(packageRoot, "dist", "web");

await mkdir(resolve(packageRoot, "dist"), { recursive: true });
await rm(target, { force: true, recursive: true });
await cp(source, target, {
  filter(sourcePath) {
    const relativePath = relative(source, sourcePath);
    if (relativePath.length === 0) {
      return true;
    }
    return !relativePath.split(sep).includes("types");
  },
  recursive: true,
});

console.log(`Copied ohbaby-web assets to ${target}`);
