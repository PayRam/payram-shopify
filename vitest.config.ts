/**
 * Vitest config, kept separate from vite.config.ts so tests run without the
 * Remix plugin (which expects a full app build context).
 */
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the "~/*" -> "app/*" aliases declared in tsconfig.json, through
  // the same plugin vite.config.ts uses for the Remix build.
  //
  // Vitest 5 runs on the project's own Vite (a peer dependency, pinned to ^6
  // because Remix v2 supports no newer major), so Vite 8's built-in
  // `resolve.tsconfigPaths` option is not available here. The alias is
  // load-bearing: the tests mock "~/db.server", so a failure to resolve it
  // surfaces immediately as an unresolved import, not silently.
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
  },
});
