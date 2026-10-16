/**
 * Health-route tests.
 *
 * The property worth protecting is the contract across two artifacts: the
 * installer greps a bash string literal for a marker defined in TypeScript.
 * Renaming either side would break install verification silently — the
 * installer would report "not reachable" for a perfectly good install, and the
 * merchant would start editing nginx configs that were already correct.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { loader, HEALTH_MARKER } from "./healthz";

describe("GET /healthz", () => {
  it("identifies the connector so a proxy's own 200 cannot be mistaken for it", async () => {
    const res = await loader();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ app: HEALTH_MARKER, ok: true });
  });

  it("is never cached — a stale 200 would make a broken route look alive", async () => {
    const res = await loader();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("leaks nothing about the build or the store", async () => {
    const body = JSON.stringify(await (await loader()).json());

    // A public endpoint on a self-hosted payments box must not fingerprint itself.
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["app", "ok"]);
    expect(body).not.toMatch(/myshopify|version|commit|sha/i);
  });

  it("matches the marker the installer greps for", () => {
    const installer = readFileSync("setup_payram_shopify.sh", "utf8");
    const declared = installer.match(/^HEALTH_MARKER="([^"]+)"$/m);

    expect(declared?.[1]).toBe(HEALTH_MARKER);
  });
});
