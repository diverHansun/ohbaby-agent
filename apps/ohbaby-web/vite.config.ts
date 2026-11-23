import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * KaTeX's stylesheet lists WOFF2, WOFF and TTF for every font. Every browser
 * the Web supports reads WOFF2, so the build keeps only those (~250KB instead
 * of ~1MB).
 */
function katexWoff2Only(): Plugin {
  return {
    name: "ohbaby-katex-woff2",
    enforce: "pre",
    transform(code, id) {
      if (
        !/\/katex\/dist\/katex\.min\.css(?:\?|$)/u.test(
          id.replaceAll("\\", "/"),
        )
      )
        return;
      return {
        code: code.replace(
          /,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/gu,
          "",
        ),
        map: null,
      };
    },
  };
}

export default defineConfig({
  build: {
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  plugins: [react(), katexWoff2Only()],
});
