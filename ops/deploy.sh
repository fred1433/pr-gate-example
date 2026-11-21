#!/usr/bin/env bash
# Deploys to the live test site the exact build the gate tested, then runs the post-deploy
# check. It never builds (invariant I1, docs/invariants.md).
#
# Usage: ops/deploy.sh [--dry-run] <gate evidence dir> "<reason>"
#   The evidence dir is the "gate-evidence" artifact of a gate run:
#     gh run download <run id> -n gate-evidence -D <dir>
#   It holds verdict.json and tested-build/ (worker/index.js, dist/, sha.txt).
#   --dry-run does every check, then `wrangler deploy --dry-run`; it needs no token.
# Refuses (exit 3) if the fingerprint of tested-build/ is not the one in verdict.json.
# Refuses (exit 4) a verdict other than "Checks passed" or "Human decision required",
# or a checkout whose HEAD tree is not the tested commit's tree.
# Needs CLOUDFLARE_API_TOKEN, LIVE_FORM_TEST_TOKEN, LIVE_INBOX_TOKEN (not for --dry-run).
set -euo pipefail
cd "$(dirname "$0")/.."
usage='usage: ops/deploy.sh [--dry-run] <gate evidence dir> "<reason>"'
dry=0
if [ "${1:-}" = "--dry-run" ]; then dry=1; shift; fi
ev="${1:-}"; reason="${2:-}"
if [ -z "$ev" ] || [ -z "$reason" ]; then echo "$usage" >&2; exit 2; fi
if [ ! -f "$ev/verdict.json" ] || [ ! -d "$ev/tested-build" ]; then
  echo "$ev must hold verdict.json and tested-build/ (gh run download <run id> -n gate-evidence -D $ev)" >&2; exit 2
fi

field() { node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const x = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), v); process.stdout.write(x == null ? "" : String(x));' "$ev/verdict.json" "$1"; }
verdict=$(field verdict); commit=$(field commit); want=$(field artifact.sha256)

# 1. The build handed over is the build that was tested.
if [ -z "$want" ]; then echo "refused: verdict.json records no fingerprint of a tested build" >&2; exit 3; fi
got=$(node gate/lib/fingerprint.mjs "$ev/tested-build") || { echo "refused: tested-build/ cannot be fingerprinted" >&2; exit 3; }
if [ "$got" != "$want" ]; then
  echo "refused: tested-build/ has fingerprint $got, the gate tested $want. This is not the build that was checked." >&2; exit 3
fi
echo "fingerprint $got matches the tested build"

# 2. The verdict allows it, and it is the build of the commit checked out here.
case "$verdict" in
  checks-passed|human-decision) ;;
  *) echo "refused: the verdict for this build is \"$verdict\"" >&2; exit 4 ;;
esac
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then echo "refused: verdict.json names no commit" >&2; exit 4; fi
if [ "$(head -c 40 "$ev/tested-build/sha.txt" 2>/dev/null)" != "$commit" ]; then echo "refused: tested-build/sha.txt is not the commit of the verdict" >&2; exit 4; fi
if ! git cat-file -e "$commit^{commit}" 2>/dev/null; then echo "refused: commit $commit is not in this checkout (git fetch first)" >&2; exit 4; fi
if [ "$(git rev-parse "HEAD^{tree}")" != "$(git rev-parse "$commit^{tree}")" ]; then
  echo "refused: this checkout ($(git rev-parse --short HEAD)) does not hold the files of the tested commit ${commit:0:7}. Update the pull request with main and let the gate run again." >&2; exit 4
fi
echo "verdict \"$verdict\" for commit ${commit:0:7}, the tree checked out here"

# 3. Deploy that build as it is: no bundling, the hosting config of this commit.
for v in CLOUDFLARE_API_TOKEN LIVE_FORM_TEST_TOKEN LIVE_INBOX_TOKEN; do
  if [ "$dry" = 0 ] && [ -z "${!v:-}" ]; then echo "$v is not set" >&2; exit 2; fi
done
stage=$(mktemp -d)
cp -R "$ev/tested-build/worker" "$ev/tested-build/dist" "$stage/"
{ echo 'no_bundle = true'; echo 'find_additional_modules = false'; git show "HEAD:site/wrangler.toml"; } > "$stage/wrangler.toml"
wrangler="$PWD/gate/node_modules/.bin/wrangler"
short=${commit:0:7}
out=$(mktemp)
if [ "$dry" = 1 ]; then
  (cd "$stage" && "$wrangler" deploy --dry-run --outdir "$stage/.dry") >"$out" 2>&1 || { tail -20 "$out"; exit 1; }
  echo "dry run: wrangler accepted the tested build of $short; nothing was deployed"
  exit 0
fi
(cd "$stage" && "$wrangler" deploy --message "$reason ($short)") >"$out" 2>&1 || { tail -20 "$out"; exit 1; }
version=$(grep -oE 'Current Version ID: [0-9a-f-]+' "$out" | awk '{print $4}')
check=$(node ops/postdeploy-check.mjs 2>&1) && status=0 || status=$?
{
  echo
  echo "### $(TZ=America/Chicago date '+%Y-%m-%d %H:%M %Z') deploy of commit $short"
  echo "Reason: $reason"
  echo "Tested build: fingerprint $got (gate verdict \"$verdict\")"
  echo "Worker version: $version"
  echo '```'
  echo "$check"
  echo '```'
} >> evidence/deploy-log.md
echo "$check"
echo "deployed version $version (commit $short, the tested build), logged in evidence/deploy-log.md"
exit $status
