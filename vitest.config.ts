/**
 * Vitest config, kept separate from vite.config.ts so tests run without the
 * React Router plugin (which expects a full app build context).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the "~/*" -> "app/*" aliases declared in tsconfig.json, with the
  // same built-in Vite 8 resolver vite.config.ts uses for the app build.
  //
  // The alias is load-bearing: the tests mock "~/db.server", so a failure to
  // resolve it surfaces immediately as an unresolved import, not silently.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    // scripts/: the release workflow's decisions (should-publish-latest.sh).
    include: ["app/**/*.test.ts", "app/**/*.test.tsx", "scripts/**/*.test.ts"],
  },
});
