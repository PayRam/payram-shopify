import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 2798),
    allowedHosts: true,
    warmup: {
      clientFiles: ["./app/entry.client.tsx"],
    },
  },
  plugins: [
    remix({
      // Everything in app/routes is a build input, so a colocated test would be
      // compiled as a route — and client builds strip server-only exports like
      // `loader`, which breaks the build rather than the test run.
      ignoredRouteFiles: ["**/.DS_Store", "**/*.test.ts", "**/*.test.tsx"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
});
