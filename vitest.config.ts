import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/db/test/**/*.test.ts"],
  },
});
