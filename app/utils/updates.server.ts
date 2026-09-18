/**
 * Release check — telling merchants an update exists.
 *
 * WHY THIS EXISTS
 * ---------------
 * Self-hosting is the product: no account to lock, no funds to freeze, nothing
 * reported. The same property means nobody can push a fix to a merchant. The
 * currency bug that booked €50 orders as $50 sat in a published image for four
 * months partly because there was no way for a merchant to learn an update
 * existed.
 *
 * So the connector tells them, and stops there. It never reaches out and changes
 * anything: no Docker socket, no self-update. Updating a payments component is
 * the merchant's decision, and a container that can replace itself is a far
 * bigger door than the problem it closes.
 *
 * WHAT IS SENT
 * ------------
 * An unauthenticated GET to GitHub's public releases API. No store domain, no
 * order data, no identifiers — nothing that could report on a merchant. Shops can
 * switch it off entirely (`updateChecksEnabled`).
 */
import prisma from "~/db.server";

const RELEASES_URL =
  "https://api.github.com/repos/PayRam/payram-shopify/releases/latest";

/** GitHub allows 60 unauthenticated calls an hour per IP; once a day is ample. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 8_000;

/**
 * One refresh at a time per process. Several admins opening the dashboard at
 * once would otherwise each fire a GitHub request and each write the same row.
 */
let inFlight: Promise<void> | null = null;

/** Marker in a release body meaning "a docker pull is not enough". */
const INSTALLER_MARKER = /\[installer-required\]/i;

/** Single row — the release is the same for every shop on this server. */
const SINGLETON_ID = "singleton";

export interface UpdateStatus {
  /** Version this container was built as, e.g. "1.1.0". Null on older images. */
  currentVersion: string | null;
  /** Commit this container was built from. Null on older images. */
  currentCommit: string | null;
  latestVersion: string | null;
  latestUrl: string | null;
  releaseNotes: string | null;
  publishedAt: Date | null;
  /** True when the checkout extension or permission list changed in the release. */
  requiresInstaller: boolean;
  /** True only when we are confident a newer release exists. */
  updateAvailable: boolean;
  /** True when the running image predates version stamping. */
  versionUnknown: boolean;
  /** False when the shop has switched update checks off. */
  enabled: boolean;
  /**
   * True when we have a successful check to report. When false the UI must say
   * nothing about being current — silence is honest, "up to date" is a claim.
   */
  checked: boolean;
  checkedAt: Date | null;
}

/** The version baked in at build time. Absent on images built before this shipped. */
export function runningVersion(): { version: string | null; commit: string | null } {
  const version = (process.env.PAYRAM_VERSION ?? "").trim();
  const commit = (process.env.PAYRAM_BUILD_SHA ?? "").trim();
  return {
    version: version || null,
    commit: commit || null,
  };
}

/**
 * Compare two dotted versions.
 *
 * Returns > 0 when `a` is newer. Non-numeric or missing parts sort as 0, so a
 * pre-release suffix never reads as newer than the release it precedes.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((n) => (/^\d+$/.test(n) ? Number(n) : 0));

  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * Refresh the cached release, at most once per interval.
 *
 * Never throws: a failed check must not break the settings page. Failures are
 * recorded so the UI can stay silent rather than guess.
 */
async function refreshIfStale(): Promise<void> {
  if (inFlight) return inFlight;

  const cached = await prisma.updateCheck.findUnique({
    where: { id: SINGLETON_ID },
  });

  if (cached && Date.now() - cached.checkedAt.getTime() < CHECK_INTERVAL_MS) {
    return;
  }

  inFlight = doRefresh(cached).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh(
  cached: Awaited<ReturnType<typeof prisma.updateCheck.findUnique>>,
): Promise<void> {

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let release: GithubRelease | null = null;
  let error: string | null = null;

  try {
    const res = await fetch(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "payram-shopify-connector",
      },
      signal: controller.signal,
    });
    if (res.ok) {
      release = (await res.json()) as GithubRelease;
    } else if (res.status === 404) {
      // No release published yet — a valid answer, not a failure.
      release = null;
    } else {
      error = `GitHub returned HTTP ${res.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeoutId);
  }

  if (error) {
    console.warn("[payram-update] release check failed:", error);
  }

  const usable = release && !release.draft && !release.prerelease ? release : null;
  const data = {
    latestVersion: usable?.tag_name?.replace(/^v/i, "") ?? cached?.latestVersion ?? null,
    latestUrl: usable?.html_url ?? cached?.latestUrl ?? null,
    releaseNotes: usable?.body ?? cached?.releaseNotes ?? null,
    publishedAt: usable?.published_at
      ? new Date(usable.published_at)
      : cached?.publishedAt ?? null,
    requiresInstaller: usable?.body
      ? INSTALLER_MARKER.test(usable.body)
      : cached?.requiresInstaller ?? false,
    // Only stamp checkedAt on success, so a failure retries on the next load
    // instead of going quiet for a day.
    checkedAt: error ? cached?.checkedAt ?? new Date(0) : new Date(),
    lastError: error,
  };

  await prisma.updateCheck.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });
}

/**
 * Current update status for a shop's dashboard.
 *
 * Returns a quiet result (nothing available) whenever we cannot be sure — the
 * shop opted out, the check failed, or the running image has no version stamp.
 * A false "update available" is worse than silence: it sends merchants to run
 * commands they did not need.
 */
export async function getUpdateStatus(shop: string): Promise<UpdateStatus> {
  const { version, commit } = runningVersion();

  const quiet: UpdateStatus = {
    currentVersion: version,
    currentCommit: commit,
    latestVersion: null,
    latestUrl: null,
    releaseNotes: null,
    publishedAt: null,
    requiresInstaller: false,
    updateAvailable: false,
    versionUnknown: version === null,
    enabled: true,
    checked: false,
    checkedAt: null,
  };

  const config = await prisma.merchantConfig.findUnique({
    where: { shop },
    select: { updateChecksEnabled: true },
  });
  if (!config?.updateChecksEnabled) return { ...quiet, enabled: false };

  // Serve whatever is cached and refresh out of band. Awaiting the network here
  // would block the merchant's dashboard for the full timeout on the first load
  // after the cache expires — on exactly the locked-down self-hosted servers
  // most likely to have no egress to GitHub.
  const cached = await prisma.updateCheck.findUnique({
    where: { id: SINGLETON_ID },
  });

  const stale =
    !cached || Date.now() - cached.checkedAt.getTime() >= CHECK_INTERVAL_MS;
  if (stale) {
    void refreshIfStale().catch((err) =>
      console.warn("[payram-update] background refresh failed:", err),
    );
  }

  if (!cached?.latestVersion || cached.lastError) return quiet;

  return {
    currentVersion: version,
    currentCommit: commit,
    latestVersion: cached.latestVersion,
    latestUrl: cached.latestUrl,
    releaseNotes: cached.releaseNotes,
    publishedAt: cached.publishedAt,
    requiresInstaller: cached.requiresInstaller,
    // An unstamped image cannot be compared, so say nothing rather than nag.
    updateAvailable:
      version !== null && compareVersions(cached.latestVersion, version) > 0,
    versionUnknown: version === null,
    enabled: true,
    checked: true,
    checkedAt: cached.checkedAt,
  };
}
