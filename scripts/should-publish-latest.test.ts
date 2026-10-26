/**
 * Where `latest` points — what every installer merchant runs.
 *
 * The regression locked down here (audit F5, 2026-10-26): `latest` was
 * published only from main pushes, which carry no APP_VERSION, so merchants on
 * the installer's `:latest` saw no version and were never told about a later
 * release. A v* run of main's head now moves `latest` to its stamped build, and
 * nothing that is not main's current head can move it — re-running an old tag
 * included.
 *
 * Runs the real script with a fake `git` on PATH that answers `ls-remote`; no
 * network, no real repository.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "should-publish-latest.sh");
const WORKFLOW = resolve(here, "../.github/workflows/release.yml");

const HEAD = "8a12842feb48af2bb4dcd76dfc8d91d79273d884";
const OLDER = "0c5f92c4384b0bffac4d96002445b0713ebcba02";
const TAG_OBJECT = "4864cab74f8540329d3349b8cbe14778dee46049";

const bin = mkdtempSync(join(tmpdir(), "payram-latest-"));
// `git ls-remote <remote> refs/heads/main` → FAKE_MAIN_HEAD;
// `git ls-remote --tags <remote> refs/tags/v*` → FAKE_TAGS (tab-separated lines).
writeFileSync(
  join(bin, "git"),
  [
    "#!/usr/bin/env bash",
    '[ "$1" = ls-remote ] || { echo "unexpected git $*" >&2; exit 2; }',
    '[ -n "${FAKE_GIT_FAILS:-}" ] && { echo "fatal: unable to access remote" >&2; exit 128; }',
    'if [ "$2" = --tags ]; then printf "%b" "${FAKE_TAGS:-}"; exit 0; fi',
    '[ -n "${FAKE_MAIN_HEAD:-}" ] && printf "%s\\trefs/heads/main\\n" "$FAKE_MAIN_HEAD"',
    "exit 0",
  ].join("\n"),
);
chmodSync(join(bin, "git"), 0o755);

afterAll(() => rmSync(bin, { recursive: true, force: true }));

/** Annotated tag `name` on `commit`, as `git ls-remote --tags` lists it. */
const annotatedTag = (name: string, commit: string, object = TAG_OBJECT) =>
  `${object}\\trefs/tags/${name}\\n${commit}\\trefs/tags/${name}^{}\\n`;

function decide(env: {
  ref: string;
  refType: "branch" | "tag";
  sha: string;
  mainHead?: string;
  tags?: string;
  gitFails?: boolean;
}): { publish: string | null; out: string; status: number } {
  const outputFile = join(bin, `output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(outputFile, "");
  let out = "";
  let status = 0;
  try {
    out = execFileSync("bash", [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REF: env.ref,
        GITHUB_REF_TYPE: env.refType,
        GITHUB_SHA: env.sha,
        GITHUB_OUTPUT: outputFile,
        FAKE_MAIN_HEAD: env.mainHead ?? HEAD,
        FAKE_TAGS: env.tags ?? "",
        ...(env.gitFails ? { FAKE_GIT_FAILS: "1" } : {}),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status: number; stdout: string };
    status = e.status;
    out = e.stdout;
  }
  const match = /^publish=(true|false)$/m.exec(readFileSync(outputFile, "utf8"));
  return { publish: match ? match[1] : null, out, status };
}

describe("should-publish-latest.sh", () => {
  it("a release tag on main's head moves latest, so it carries the version", () => {
    const r = decide({ ref: "refs/tags/v1.2.1", refType: "tag", sha: HEAD });
    expect(r).toMatchObject({ status: 0, publish: "true" });
    expect(r.out).toMatch(/v1\.2\.1 is main's head/);
  });

  it("re-running an OLD tag never moves latest back", () => {
    const r = decide({ ref: "refs/tags/v1.1.0", refType: "tag", sha: OLDER });
    expect(r).toMatchObject({ status: 0, publish: "false" });
    expect(r.out).toMatch(/is not main's head/);
  });

  it("a main push that nobody has tagged moves latest", () => {
    const r = decide({
      ref: "refs/heads/main",
      refType: "branch",
      sha: HEAD,
      tags: annotatedTag("v1.1.0", OLDER),
    });
    expect(r).toMatchObject({ status: 0, publish: "true" });
  });

  it("a main push of a tagged commit leaves latest to the tag's stamped build", () => {
    const annotated = decide({
      ref: "refs/heads/main",
      refType: "branch",
      sha: HEAD,
      tags: annotatedTag("v1.1.0", OLDER) + annotatedTag("v1.2.0", HEAD),
    });
    expect(annotated).toMatchObject({ status: 0, publish: "false" });
    expect(annotated.out).toMatch(/tagged v1\.2\.0/);

    const lightweight = decide({
      ref: "refs/heads/main",
      refType: "branch",
      sha: HEAD,
      tags: `${HEAD}\\trefs/tags/v1.2.0\\n`,
    });
    expect(lightweight.publish).toBe("false");
  });

  it("a superseded main run (main has moved on) does not move latest", () => {
    const r = decide({ ref: "refs/heads/main", refType: "branch", sha: OLDER });
    expect(r.publish).toBe("false");
  });

  it("a dispatched branch build never moves latest, even at main's commit", () => {
    const r = decide({ ref: "refs/heads/ci/some-branch", refType: "branch", sha: HEAD });
    expect(r.publish).toBe("false");
  });

  it("a non-release tag does not move latest", () => {
    const r = decide({ ref: "refs/tags/nightly", refType: "tag", sha: HEAD });
    expect(r.publish).toBe("false");
  });

  it("fails, deciding nothing, when the remote cannot be read", () => {
    const failing = decide({ ref: "refs/tags/v1.2.1", refType: "tag", sha: HEAD, gitFails: true });
    expect(failing.status).not.toBe(0);
    expect(failing.publish).toBeNull();

    const empty = decide({ ref: "refs/tags/v1.2.1", refType: "tag", sha: HEAD, mainHead: "" });
    expect(empty.status).not.toBe(0);
    expect(empty.publish).toBeNull();
  });
});

describe("release.yml wiring", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("publishes latest only on the script's decision, never metadata-action's default", () => {
    expect(workflow).toContain("run: bash scripts/should-publish-latest.sh");
    expect(workflow).toContain(
      "type=raw,value=latest,enable=${{ steps.latest.outputs.publish == 'true' }}",
    );
    expect(workflow).toContain("flavor: latest=false");
    expect(workflow.match(/value=latest/g)).toHaveLength(1);
  });

  it("decides before the tags are derived, so the platform check covers latest too", () => {
    const decideAt = workflow.indexOf("name: Decide whether latest moves");
    const deriveAt = workflow.indexOf("name: Derive tags");
    const checkAt = workflow.indexOf("name: Check both platforms are published");
    expect(decideAt).toBeGreaterThan(0);
    expect(decideAt).toBeLessThan(deriveAt);
    // The check walks every tag metadata-action produced, `latest` included.
    expect(workflow.slice(checkAt)).toContain("jq -r '.tags[]'");
  });

  it("still keeps sha- tags off v* runs", () => {
    expect(workflow).toContain(
      "type=sha,prefix=sha-,format=short,enable=${{ github.ref_type != 'tag' }}",
    );
  });
});
