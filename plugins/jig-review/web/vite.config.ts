// Builds the review page (src/) into dist/, which the extension's server serves and which is committed so an install
// needs no build. Rebuild with `npm --prefix plugins/jig-review/web run build` after any change under src/. Also
// configures the page's tests (`npm --prefix plugins/jig-review/web test`): plain functions over diffs and keys, so they
// run in Node.
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@web": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
