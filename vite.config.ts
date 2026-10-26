import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 2798),
    allowedHosts: true,
    warmup: {
      clientFiles: ["./app/entry.client.tsx"],
    },
  },
  plugins: [
    // Route files (and the test files kept out of them) are declared in
    // app/routes.ts. The Remix v3_* future flags are React Router 7 defaults.
    reactRouter(),
  ],
  // "~/*" -> "app/*" from tsconfig.json. Built into Vite since 8, replacing
  // the vite-tsconfig-paths plugin.
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    assetsInlineLimit: 0,
  },
});
