/**
 * Vitest config, kept separate from vite.config.ts so tests run without the
 * Remix plugin (which expects a full app build context).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolves the "~/*" -> "app/*" aliases declared in tsconfig.json.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
  },
});
