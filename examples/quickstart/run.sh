#!/usr/bin/env bash
# Register a harness and a dataset, run a scorecard, print the verdict.
# Assumes the dev compose profile is up (no auth, tenant `default`).
set -euo pipefail

API=${EVERDICT_API_URL:-http://localhost:8787}
HDR=(-H 'content-type: application/json' -H 'x-everdict-tenant: default')
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "① registering harness   demo-agent@1.0.0"
curl -fsS -XPOST "$API/harnesses" "${HDR[@]}" -d @"$HERE/harness.json" > /dev/null

echo "② registering dataset   demo-smoke@1.0.0"
curl -fsS -XPOST "$API/datasets" "${HDR[@]}" -d @"$HERE/dataset.json" > /dev/null

echo "③ running scorecard"
ID=$(curl -fsS -XPOST "$API/scorecards" "${HDR[@]}" -d '{
  "dataset": { "id": "demo-smoke",  "version": "latest" },
  "harness": { "id": "demo-agent",  "version": "latest" },
  "trials": 1
}' | sed -n 's/.*"\(sc_[A-Za-z0-9_-]*\)".*/\1/p' | head -1)
echo "   $ID"

for _ in $(seq 1 60); do
  BODY=$(curl -fsS "$API/scorecards/$ID" "${HDR[@]}")
  case "$BODY" in
    *'"status":"succeeded"'*|*'"status":"failed"'*) break ;;
  esac
  printf '   waiting …\r'; sleep 2
done

echo "④ verdict"
echo "$BODY" | tr ',' '\n' | grep -E 'status|passed|failed|passRate' | sed 's/^/   /'
