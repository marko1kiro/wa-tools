import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/db/test/**/*.test.ts",
      "apps/wa-engine/test/**/*.test.ts",
      "apps/web/**/*.test.ts",
    ],
  },
});
