#!/usr/bin/env bash
# Check that the live site serves exactly the files in site/ (byte for byte).
# Usage: ./scripts/verify-site.sh            (checks https://live.cetlivevotes.me)
#        BASE=https://other.host ./scripts/verify-site.sh
# Pages are fetched at their clean URLs (index.html -> /, poll.html -> /poll), following redirects.
# Only the files in site/ are checked. The server code in lambda/ runs on AWS and can't be checked from outside.
set -uo pipefail
BASE="${BASE:-https://live.cetlivevotes.me}"
cd "$(dirname "$0")/.."
command -v sha256sum >/dev/null && SHA="sha256sum" || SHA="shasum -a 256"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
match=0; diff=0
while IFS= read -r file; do
  rel="${file#site/}"
  case "$rel" in
    index.html) url="/" ;;
    *.html) url="/${rel%.html}" ;;
    *) url="/$rel" ;;
  esac
  if ! curl -sSfL --max-time 30 -o "$tmp" "$BASE$url"; then
    echo "DIFF   $rel  (could not download $url)"; diff=$((diff + 1)); continue
  fi
  want=$($SHA "$file" | cut -d' ' -f1)
  got=$($SHA "$tmp" | cut -d' ' -f1)
  if [ "$want" = "$got" ]; then echo "MATCH  $rel"; match=$((match + 1))
  else echo "DIFF   $rel  (repo ${want:0:12}…, live ${got:0:12}…)"; diff=$((diff + 1)); fi
done < <(find site -type f | LC_ALL=C sort)
echo "$match match, $diff differ ($BASE)"
[ "$diff" -eq 0 ]
