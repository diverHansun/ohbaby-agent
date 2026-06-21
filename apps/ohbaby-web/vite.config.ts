import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  plugins: [react()],
});
