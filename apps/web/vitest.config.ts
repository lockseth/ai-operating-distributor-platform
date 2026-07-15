import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@flowsales/ai": path.resolve(__dirname, "../../packages/ai/src/index.ts"),
      "@flowsales/database": path.resolve(__dirname, "../../packages/database/src/index.ts"),
      "@flowsales/types": path.resolve(__dirname, "../../packages/types/src/index.ts"),
    },
  },
});
