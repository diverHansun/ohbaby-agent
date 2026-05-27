import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = path.join(os.tmpdir(), "ohbaby-agent-vitest-home");

fs.mkdirSync(testHome, { recursive: true });

process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

