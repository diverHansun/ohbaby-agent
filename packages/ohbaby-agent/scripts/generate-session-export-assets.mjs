import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const htmlRoot = join(packageRoot, "src/services/session-export/html");
const markedRoot = dirname(require.resolve("marked/package.json"));
const outputPath = join(htmlRoot, "assets.generated.ts");
const normalize = (source) => source.replace(/\r\n?/g, "\n");
const license = normalize(
  await readFile(join(markedRoot, "LICENSE.md"), "utf8"),
);
const assets = [
  ["HTML_TEMPLATE", join(htmlRoot, "template.html")],
  ["CSS_TEMPLATE", join(htmlRoot, "template.css")],
  ["VIEWER_SCRIPT", join(htmlRoot, "template.js")],
  ["MARKED_SCRIPT", join(markedRoot, "lib/marked.umd.js")],
];
const declarations = [];
for (const [name, path] of assets) {
  let source = normalize(await readFile(path, "utf8"));
  if (name === "MARKED_SCRIPT") {
    source = source.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, "");
    source = `${license
      .split("\n")
      .map((line) => `// ${line}`)
      .join("\n")}\n${source}`;
  }
  declarations.push(`export const ${name} =\n  ${JSON.stringify(source)};`);
}
const output = `// Generated from session export templates and marked (MIT). Do not edit by hand.\n// Run: node packages/ohbaby-agent/scripts/generate-session-export-assets.mjs\n\n${declarations.join("\n\n")}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (normalize(current) !== output) {
    console.error(
      "Session export assets are stale. Run: node packages/ohbaby-agent/scripts/generate-session-export-assets.mjs",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output, "utf8");
}
