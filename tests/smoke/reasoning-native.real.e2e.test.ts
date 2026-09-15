import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_REAL_PROFILES,
  runNativeProfile,
} from "./reasoning-native-harness.js";

const enabled = process.env.OHBABY_RUN_REAL_NATIVE_REASONING === "1";
const profileId = process.env.OHBABY_NATIVE_REASONING_PROFILE;
const diagnostic = process.env.OHBABY_NATIVE_REASONING_DIAGNOSTIC === "1";
describe.skipIf(!enabled)(
  "real native reasoning lifecycle with SQLite continuation",
  () => {
    it("runs the explicitly selected profile within four HTTP requests", async () => {
      const profile = NATIVE_REAL_PROFILES.find(
        (item) => item.id === profileId,
      );
      if (!profile)
        throw new Error(
          "An explicit supported native reasoning profile is required.",
        );
      const apiKey = process.env.ZENMUX_API_KEY?.trim();
      if (!apiKey)
        throw new Error("ZENMUX_API_KEY is required; no real requests made.");
      const result = await runNativeProfile(profile, {
        apiKey,
        requestLimit: diagnostic ? 1 : 4,
      });
      const evidenceDir =
        process.env.OHBABY_NATIVE_REASONING_EVIDENCE_DIR ??
        ".ohbaby/test-evidence/improve-5.5/real-native";
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(
        join(evidenceDir, `${profile.id}-${String(Date.now())}.json`),
        JSON.stringify(result, null, 2),
      );
      process.stdout.write(
        JSON.stringify({
          profile: result.profile,
          diagnostic,
          passed: result.passed,
          actualHttpRequests: result.actualHttpRequests,
          modes: result.modes.map((mode) => ({
            mode: mode.mode,
            passed: mode.passed,
            acceptedSteps: mode.acceptedSteps.length,
            nativeReplayed: mode.nativeReplayed,
            failure: mode.failure,
          })),
        }),
      );
      if (diagnostic) expect(result.actualHttpRequests).toBe(1);
      else expect(result.passed).toBe(true);
    }, 390000);
  },
);
