import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/types/**", "src/index.ts"],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 75,
        lines: 70,
      },
    },
  },
});
