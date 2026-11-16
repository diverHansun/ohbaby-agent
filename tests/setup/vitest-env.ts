import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {} from "vitest/jsdom";

// Node 25's own Storage globals can shadow jsdom's browser storage in Vitest 2.
// DOM tests must use the Storage belonging to their window, on every Node version.
if (typeof jsdom !== "undefined") {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: jsdom.window[name],
    });
  }
}

const testHome = path.join(os.tmpdir(), "ohbaby-agent-vitest-home");

fs.mkdirSync(testHome, { recursive: true });

process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
