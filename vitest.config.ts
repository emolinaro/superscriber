import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/.next/**", "**/node_modules/**", "**/e2e/**"],
    setupFiles: [resolve(__dirname, "src/test/setup.ts")],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "server-only": resolve(__dirname, "test-support/server-only.ts"),
    },
  },
});
