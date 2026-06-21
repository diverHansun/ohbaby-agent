import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
});
