#!/usr/bin/env bash
# Quick checks against the deployed site. Usage: ./scripts/smoke-test.sh
set -uo pipefail
URL=$(node -e "console.log(require('./outputs.json').UnionElection.SiteUrl)")
check() { code=$(curl -s -o /dev/null -w '%{http_code}' "$@"); echo "$code  $*"; }
check "$URL/"
check "$URL/data/results.json"
check "$URL/data/exitpoll.json"
check "$URL/api/health"
check "$URL/api/board"
echo "Expect 200 for all five. /api/admin/state without sign-in should be 401:"
check "$URL/api/admin/state"
echo "Security headers on the home page:"
curl -sI "$URL/" | grep -iE 'content-security-policy|strict-transport|x-frame' | cut -c1-90
