import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/install.test.ts", "**/copilot-e2e.test.ts"],
    testTimeout: 180000,
  },
});
