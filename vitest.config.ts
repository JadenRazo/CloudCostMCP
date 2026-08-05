import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["test/helpers/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/types/**", "src/index.ts"],
      thresholds: {
        statements: 75,
        // Actual branch coverage floor at the time the CI gate was turned on
        // (v1.1.0): 71.03%. Raise back toward 75 as branch coverage improves.
        branches: 71,
        functions: 80,
        lines: 75,
      },
    },
  },
});
