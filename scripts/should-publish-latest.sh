#!/usr/bin/env bash
# =============================================================================
# Does this release run move `payramapp/payram-shopify:latest`?
#
# `latest` is what the installer pulls, so it must be main's newest commit AND
# carry the release's version: the app shows the running version and announces
# a newer release only when the image has one (updates.server.ts). Main builds
# have no version (APP_VERSION comes from the tag), so a `latest` published
# only from main left every installer merchant on an unstamped image with no
# update notice for any later release (audit F5, 2026-10-26).
#
# The rule — `latest` only ever points at main's current head:
#   v* tag run      yes, when the tagged commit is main's head right now. A
#                   re-run of an older tag is not main's head, so it can never
#                   move `latest` back.
#   main push run   yes, when this commit is main's head and no v* tag points at
#                   it. A tagged commit is published by the tag's own run, with
#                   its version; the two runs race, and an unstamped main build
#                   finishing last would otherwise replace the stamped one.
#   anything else   no (a dispatched branch build, a superseded main run).
#
# Asks the remote, not the checkout, so a run that started before a newer push
# sees the newer head. The repository is public, so no credential is needed.
#
# Inputs (set by GitHub Actions): GITHUB_REF, GITHUB_REF_TYPE, GITHUB_SHA.
# RELEASE_REMOTE overrides the remote (default: origin).
# Output: `publish=true|false`, appended to $GITHUB_OUTPUT when set, otherwise
# printed. Exits non-zero, publishing nothing, when the remote cannot be read.
# =============================================================================
set -euo pipefail

remote="${RELEASE_REMOTE:-origin}"
sha="${GITHUB_SHA:?GITHUB_SHA is required}"
ref="${GITHUB_REF:?GITHUB_REF is required}"
ref_type="${GITHUB_REF_TYPE:-}"

main_head="$(git ls-remote "$remote" refs/heads/main | cut -f1)"
if [ -z "$main_head" ]; then
  echo "::error::Could not read the head of main from ${remote}; not deciding where latest points."
  exit 1
fi

publish=false
if [ "$sha" != "$main_head" ]; then
  reason="${sha:0:7} is not main's head (${main_head:0:7}), so latest stays where it is"
elif [ "$ref_type" = "tag" ]; then
  case "$ref" in
    refs/tags/v*)
      publish=true
      reason="${ref#refs/tags/} is main's head, so latest carries its version"
      ;;
    *)
      reason="${ref} is not a release tag"
      ;;
  esac
elif [ "$ref" = "refs/heads/main" ]; then
  # Annotated tags are listed twice; the peeled `^{}` line carries the commit.
  release_tags="$(git ls-remote --tags "$remote" 'refs/tags/v*' \
    | awk -v sha="$sha" '$1 == sha { sub("^refs/tags/", "", $2); sub("\\^\\{\\}$", "", $2); print $2 }' \
    | sort -u | tr '\n' ' ')"
  if [ -n "$release_tags" ]; then
    reason="${sha:0:7} is tagged ${release_tags% }, whose run publishes latest with the version"
  else
    publish=true
    reason="${sha:0:7} is main's head and not tagged"
  fi
else
  reason="${ref} is not main"
fi

echo "latest: ${reason}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "publish=${publish}" >> "$GITHUB_OUTPUT"
else
  echo "publish=${publish}"
fi
