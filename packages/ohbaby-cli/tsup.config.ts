import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  outDir: "dist",
  treeshake: true,
  minify: false,
  external: ["ohbaby-sdk", "react", "ink"],
});
