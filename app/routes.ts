import { flatRoutes } from "@react-router/fs-routes";

// File-based routes, the same convention the Remix build used.
//
// Everything in app/routes is a build input, so a colocated test would be
// compiled as a route — and client builds strip server-only exports like
// `loader`, which breaks the build rather than the test run.
export default flatRoutes({
  ignoredRouteFiles: ["**/.DS_Store", "**/*.test.ts", "**/*.test.tsx"],
});
