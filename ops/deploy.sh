#!/usr/bin/env bash
# Deploys site/ to the live test site, then runs the post-deploy check.
# Usage: ops/deploy.sh "<reason>"
# Needs CLOUDFLARE_API_TOKEN, LIVE_FORM_TEST_TOKEN, LIVE_INBOX_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
reason="${1:-}"
if [ -z "$reason" ]; then echo 'usage: ops/deploy.sh "<reason>"' >&2; exit 2; fi
for v in CLOUDFLARE_API_TOKEN LIVE_FORM_TEST_TOKEN LIVE_INBOX_TOKEN; do
  if [ -z "${!v:-}" ]; then echo "$v is not set" >&2; exit 2; fi
done
sha=$(git rev-parse --short HEAD)
out=$(mktemp)
(cd site && npm run build >/dev/null && npx wrangler deploy --message "$reason ($sha)") >"$out" 2>&1 || { tail -20 "$out"; exit 1; }
version=$(grep -oE 'Current Version ID: [0-9a-f-]+' "$out" | awk '{print $4}')
check=$(node ops/postdeploy-check.mjs 2>&1) && status=0 || status=$?
{
  echo
  echo "### $(TZ=America/Chicago date '+%Y-%m-%d %H:%M %Z') deploy of commit $sha"
  echo "Reason: $reason"
  echo "Worker version: $version"
  echo '```'
  echo "$check"
  echo '```'
} >> evidence/deploy-log.md
echo "$check"
echo "deployed version $version (commit $sha), logged in evidence/deploy-log.md"
exit $status
