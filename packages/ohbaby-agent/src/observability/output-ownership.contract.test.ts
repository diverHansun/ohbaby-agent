import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const backendProbePath = path.join(
  repositoryRoot,
  "packages/ohbaby-agent/src/host/command-recorder.ts",
);
const sqliteWarningAllowlistPath = path.join(
  repositoryRoot,
  "packages/ohbaby-agent/src/services/database/connection.ts",
);
const cliRuntimeProbePath = path.join(
  repositoryRoot,
  "packages/ohbaby-cli/src/tui/format-error.ts",
);
const cliCompositionProbePath = path.join(
  repositoryRoot,
  "packages/ohbaby-cli/src/bin.ts",
);

async function lintProbe(
  source: string,
  filePath = backendProbePath,
): Promise<readonly string[]> {
  const eslint = new ESLint({ cwd: repositoryRoot });
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.map(
    (message) => `${message.ruleId ?? "parser"}:${message.message}`,
  );
}

describe("backend output ownership lint", () => {
  it.each([
    ["stdout", 'process.stdout.write("leak");'],
    ["stderr", 'process.stderr.write("leak");'],
    ["global warning", 'process.emitWarning("leak");'],
    ["console", 'console.error("leak");'],
  ])("rejects direct %s output", async (_label, source) => {
    await expect(lintProbe(source)).resolves.toEqual([
      expect.stringMatching(/^(?:no-console|no-restricted-properties):/u),
    ]);
  });

  it.each([
    [
      "named process import",
      'import { stdout as output } from "node:process"; output.write("leak");',
    ],
    [
      "default process alias",
      'import processAlias from "node:process"; processAlias.stderr.write("leak");',
    ],
    [
      "process destructuring",
      'const { stderr: output } = process; output.write("leak");',
    ],
    [
      "global process alias",
      'const processAlias = process; processAlias.stderr.write("leak");',
    ],
    [
      "globalThis process alias",
      'const processAlias = globalThis.process; processAlias.stdout.write("leak");',
    ],
    [
      "globalThis process destructuring",
      'const { stderr: output } = globalThis.process; output.write("leak");',
    ],
    [
      "computed globalThis process alias",
      'const processAlias = globalThis["process"]; processAlias.stdout.write("leak");',
    ],
    [
      "computed globalThis process destructuring",
      'const { stdout: output } = globalThis["process"]; output.write("leak");',
    ],
    ["globalThis process output", 'globalThis.process.stderr.write("leak");'],
    [
      "computed globalThis process output",
      'globalThis["process"].stderr.write("leak");',
    ],
  ])("rejects %s bypasses", async (_label, source) => {
    await expect(lintProbe(source)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^(?:no-restricted-imports|no-restricted-syntax):/u,
        ),
      ]),
    );
  });

  it("keeps the audited SQLite warning interceptor narrow", async () => {
    await expect(
      lintProbe(
        'process.emitWarning("forwarded by the SQLite interceptor");',
        sqliteWarningAllowlistPath,
      ),
    ).resolves.toEqual([]);
    await expect(
      lintProbe('process.stderr.write("leak");', sqliteWarningAllowlistPath),
    ).resolves.toEqual([expect.stringMatching(/^no-restricted-properties:/u)]);
  });
});

describe("CLI runtime import boundary lint", () => {
  it.each([
    "ohbaby-agent",
    "ohbaby-agent/subpath",
    "ohbaby-server",
    "ohbaby-server/subpath",
    "../../../ohbaby-agent/src/index.js",
    "../../../ohbaby-agent/dist/index.js",
    "../../../ohbaby-server/src/index.js",
    "../../../ohbaby-server/dist/index.js",
  ])("rejects the static runtime import %s", async (specifier) => {
    await expect(
      lintProbe(
        `import { runtime } from ${JSON.stringify(specifier)}; void runtime;`,
        cliRuntimeProbePath,
      ),
    ).resolves.toEqual([expect.stringMatching(/^no-restricted-imports:/u)]);
  });

  it.each(["ohbaby-agent", "ohbaby-server"])(
    "allows type-only imports from %s at the CLI composition root",
    async (specifier) => {
      await expect(
        lintProbe(
          `export type { RuntimeType } from ${JSON.stringify(specifier)};`,
          cliCompositionProbePath,
        ),
      ).resolves.toEqual([]);
    },
  );

  it.each([
    "ohbaby-agent",
    "ohbaby-agent/subpath",
    "ohbaby-server",
    "ohbaby-server/subpath",
    "../../../ohbaby-agent/src/index.js",
    "../../../ohbaby-agent/dist/index.js",
    "../../../ohbaby-server/src/index.js",
    "../../../ohbaby-server/dist/index.js",
  ])("rejects the dynamic runtime import %s", async (specifier) => {
    await expect(
      lintProbe(
        `const runtime = await import(${JSON.stringify(specifier)}); void runtime;`,
        cliRuntimeProbePath,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^no-restricted-syntax:/u),
      ]),
    );
  });

  it("rejects a variable dynamic import outside the CLI composition root", async () => {
    await expect(
      lintProbe(
        'const specifier = "ohbaby-agent"; const runtime = await import(specifier); void runtime;',
        cliRuntimeProbePath,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^no-restricted-syntax:/u),
      ]),
    );
  });

  it("requires the explicit composition-root loader to use a narrow inline allowlist", async () => {
    await expect(
      lintProbe(
        `export async function importRuntimeModule(specifier: string): Promise<unknown> {
  // eslint-disable-next-line no-restricted-syntax -- audited composition-root loader
  return import(specifier);
}`,
        cliCompositionProbePath,
      ),
    ).resolves.toEqual([]);
    await expect(
      lintProbe(
        'const moduleName = "ohbaby-agent"; const runtime = await import(moduleName); void runtime;',
        cliCompositionProbePath,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^no-restricted-syntax:/u),
      ]),
    );
    await expect(
      lintProbe(
        'async function eagerLoad(): Promise<unknown> { const specifier = "ohbaby-agent"; return import(specifier); } void eagerLoad;',
        cliCompositionProbePath,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^no-restricted-syntax:/u),
      ]),
    );
    await expect(
      lintProbe(
        'const runtime = await import("ohbaby-agent"); void runtime;',
        cliCompositionProbePath,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^no-restricted-syntax:/u),
      ]),
    );
  });
});
