import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"], // we'll create this next
    include: ["src/**/*.test.ts"],
  },
});
