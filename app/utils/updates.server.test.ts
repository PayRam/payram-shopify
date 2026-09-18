/**
 * Update-check tests.
 *
 * The property that matters most is restraint: a false "update available" sends
 * merchants to run commands against a live payments server for no reason, so
 * every uncertain case must stay silent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    config: null as Record<string, unknown> | null,
    check: null as Record<string, unknown> | null,
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    merchantConfig: { findUnique: async () => db.config },
    updateCheck: {
      findUnique: async () => db.check,
      upsert: async ({ create, update }: never) => {
        db.check = { ...(db.check ?? (create as object)), ...(update as object) };
        return db.check;
      },
    },
  },
}));

import { compareVersions, getUpdateStatus, runningVersion } from "./updates.server";

const fetchMock = vi.fn();

function release(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  // Opt-in in production; tests enable it explicitly.
  db.config = { updateChecksEnabled: true };
  db.check = null;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("PAYRAM_VERSION", "1.1.0");
  vi.stubEnv("PAYRAM_BUILD_SHA", "c26e238736ab22c5bd3e6edc69581f987087ab8c");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("compareVersions", () => {
  it.each([
    ["1.2.0", "1.1.0", 1],
    ["1.1.0", "1.2.0", -1],
    ["1.1.0", "1.1.0", 0],
    ["v2.0.0", "1.9.9", 1],
    ["1.10.0", "1.9.0", 1],
    ["1.1.1", "1.1", 1],
  ])("compares %s to %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a as string, b as string))).toBe(sign);
  });

  it("does not treat a pre-release as newer than its release", () => {
    expect(compareVersions("1.2.0-rc1", "1.2.0")).toBe(0);
  });
});

describe("runningVersion", () => {
  it("reads what the build baked in", () => {
    expect(runningVersion().version).toBe("1.1.0");
  });

  it("returns null on an image built before version stamping", () => {
    vi.stubEnv("PAYRAM_VERSION", "");
    vi.stubEnv("PAYRAM_BUILD_SHA", "");
    expect(runningVersion()).toEqual({ version: null, commit: null });
  });
});

/**
 * The check refreshes out of band so the dashboard never blocks on GitHub, so a
 * caller sees a new release on the load AFTER the one that fetched it.
 */
async function statusAfterRefresh() {
  await getUpdateStatus("demo.myshopify.com");
  await vi.waitFor(() => expect(db.check).not.toBeNull());
  return getUpdateStatus("demo.myshopify.com");
}

describe("getUpdateStatus", () => {
  it("never blocks the dashboard on the network", async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (release = r)));

    // Resolves while the request is still outstanding.
    const s = await getUpdateStatus("demo.myshopify.com");
    expect(s.updateAvailable).toBe(false);
    expect(s.checked).toBe(false);

    release({ ok: true, status: 200, json: async () => ({ tag_name: "v1.2.0" }) });
  });

  it("reports an update when a newer release exists", async () => {
    fetchMock.mockResolvedValue(
      release({ tag_name: "v1.2.0", body: "Fixes things", html_url: "https://x", published_at: "2026-09-18T00:00:00Z" }),
    );

    const s = await statusAfterRefresh();

    expect(s.updateAvailable).toBe(true);
    expect(s.checked).toBe(true);
    expect(s.latestVersion).toBe("1.2.0");
    expect(s.releaseNotes).toBe("Fixes things");
    expect(s.requiresInstaller).toBe(false);
  });

  it("flags releases that need the installer", async () => {
    fetchMock.mockResolvedValue(
      release({ tag_name: "v1.2.0", body: "New checkout block [installer-required]" }),
    );

    expect((await statusAfterRefresh()).requiresInstaller).toBe(true);
  });

  it("stays quiet when the running version is already latest", async () => {
    fetchMock.mockResolvedValue(release({ tag_name: "v1.1.0", body: "notes" }));
    expect((await statusAfterRefresh()).updateAvailable).toBe(false);
  });

  it("stays quiet when the running version is newer than the release", async () => {
    vi.stubEnv("PAYRAM_VERSION", "1.3.0");
    fetchMock.mockResolvedValue(release({ tag_name: "v1.2.0", body: "notes" }));
    expect((await statusAfterRefresh()).updateAvailable).toBe(false);
  });

  it("stays quiet — and says so — when the image has no version stamp", async () => {
    vi.stubEnv("PAYRAM_VERSION", "");
    fetchMock.mockResolvedValue(release({ tag_name: "v9.9.9", body: "notes" }));

    const s = await statusAfterRefresh();

    expect(s.updateAvailable).toBe(false);
    expect(s.versionUnknown).toBe(true);
  });

  it("never calls out when the shop opted out", async () => {
    db.config = { updateChecksEnabled: false };
    await getUpdateStatus("demo.myshopify.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays quiet when GitHub is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
    const s = await getUpdateStatus("demo.myshopify.com");
    expect(s.updateAvailable).toBe(false);
    expect(s.latestVersion).toBeNull();
  });

  it("ignores drafts and pre-releases", async () => {
    fetchMock.mockResolvedValue(
      release({ tag_name: "v2.0.0", body: "beta", draft: false, prerelease: true }),
    );
    expect((await statusAfterRefresh()).updateAvailable).toBe(false);
  });

  it("serves the cache instead of calling GitHub again", async () => {
    fetchMock.mockResolvedValue(release({ tag_name: "v1.2.0", body: "notes" }));
    await statusAfterRefresh();
    await getUpdateStatus("demo.myshopify.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on the next load after a failure rather than going quiet for a day", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await getUpdateStatus("demo.myshopify.com");
    await vi.waitFor(() => expect(db.check).not.toBeNull());

    fetchMock.mockResolvedValue(release({ tag_name: "v1.2.0", body: "notes" }));
    const s = await statusAfterRefresh();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(s.updateAvailable).toBe(true);
  });

  it("sends nothing identifying about the store", async () => {
    fetchMock.mockResolvedValue(release({ tag_name: "v1.2.0", body: "notes" }));
    await statusAfterRefresh();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.github.com/repos/PayRam/payram-shopify/releases/latest",
    );
    expect(JSON.stringify(init ?? {})).not.toContain("demo.myshopify.com");
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });
});

describe("getUpdateStatus — opt-in", () => {
  it("stays off when a shop has no config row yet", async () => {
    db.config = null;
    const s = await getUpdateStatus("demo.myshopify.com");

    expect(s.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed check as unchecked rather than up to date", async () => {
    fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
    await getUpdateStatus("demo.myshopify.com");
    await vi.waitFor(() => expect(db.check).not.toBeNull());

    const s = await getUpdateStatus("demo.myshopify.com");
    expect(s.checked).toBe(false);
    expect(s.updateAvailable).toBe(false);
  });
});
