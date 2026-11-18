import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "test/**/*.integration.test.ts"],
    testTimeout: 15000,
  },
});
