#!/usr/bin/env bash
# Puts an earlier Worker version back live, then runs the post-deploy check.
# Usage: ops/rollback.sh <version-id> "<reason>"
# Version ids are in evidence/deploy-log.md (one per deploy).
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:-}"; reason="${2:-}"
if [ -z "$version" ] || [ -z "$reason" ]; then echo 'usage: ops/rollback.sh <version-id> "<reason>"' >&2; exit 2; fi
for v in CLOUDFLARE_API_TOKEN LIVE_FORM_TEST_TOKEN LIVE_INBOX_TOKEN; do
  if [ -z "${!v:-}" ]; then echo "$v is not set" >&2; exit 2; fi
done
out=$(mktemp)
(cd site && npx wrangler rollback "$version" --message "$reason" --yes) >"$out" 2>&1 || { tail -20 "$out"; exit 1; }
check=$(node ops/postdeploy-check.mjs 2>&1) && status=0 || status=$?
{
  echo
  echo "### $(TZ=America/Chicago date '+%Y-%m-%d %H:%M %Z') rollback to version $version"
  echo "Reason: $reason"
  echo '```'
  # wrangler's own prompts and decorations stay out of the log; only its result line is kept
  grep -oE 'Worker Version [0-9a-f-]+ has been deployed to 100% of traffic\.' "$out" | head -1
  echo "$check"
  echo '```'
} >> evidence/deploy-log.md
echo "$check"
echo "rolled back to $version, logged in evidence/deploy-log.md"
exit $status
