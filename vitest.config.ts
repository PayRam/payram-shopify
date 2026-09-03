/**
 * Vitest config, kept separate from vite.config.ts so tests run without the
 * Remix plugin (which expects a full app build context).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolves the "~/*" -> "app/*" aliases declared in tsconfig.json.
    //
    // This is a Vite 7+ option, and package.json pins vite ^5 — but that copy is
    // only used by the Remix build, which resolves aliases through the
    // vite-tsconfig-paths PLUGIN in vite.config.ts. Vitest runs on its own
    // bundled Vite (8.x), where this option is supported. The alias is
    // load-bearing here: the tests mock "~/db.server", so a failure to resolve
    // it would surface immediately as an unresolved import, not silently.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
  },
});
