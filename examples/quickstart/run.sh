#!/usr/bin/env bash
# Register a runtime, a harness and a dataset, run a scorecard, print the verdict.
# Assumes the dev compose profile is up (no auth, tenant `default`). Safe to run again: a document that is
# already registered answers 409 and is left as it is.
set -euo pipefail

API=${EVERDICT_API_URL:-http://localhost:8787}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

# POST a JSON body (a file with @path, or inline); 2xx and 409 are fine, anything else stops the script.
post() {
  local path=$1 body=$2 out code
  out=$(mktemp)
  code=$(curl -sS -o "$out" -w '%{http_code}' -XPOST "$API$path" \
    -H 'content-type: application/json' -H 'x-everdict-tenant: default' -d "$body")
  if [[ $code != 2* && $code != 409 ]]; then
    echo "   ✗ POST $path → $code: $(cat "$out")" >&2
    rm -f "$out"
    exit 1
  fi
  cat "$out"
  rm -f "$out"
}
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v===undefined?"":typeof v==="string"?v:JSON.stringify(v))})' "$1"; }

echo "① registering runtime   local@1.0.0"
post /runtimes @"$ROOT/examples/runtimes/local-1.0.0.json" > /dev/null

echo "② registering harness   demo-agent@1.0.0 (template + instance)"
post /harness-templates @"$HERE/harness.json" > /dev/null
post /harnesses '{"template":{"id":"demo-agent","version":"1.0.0"},"id":"demo-agent","version":"1.0.0","pins":{}}' > /dev/null

echo "③ registering dataset   demo-smoke@1.0.0"
post /datasets @"$HERE/dataset.json" > /dev/null

echo "④ running scorecard"
ID=$(post /scorecards '{
  "dataset": { "id": "demo-smoke", "version": "latest" },
  "harness": { "id": "demo-agent", "version": "latest" },
  "runtime": "local",
  "trials": 1
}' | field id)
echo "   $ID"

STATUS=""
for _ in $(seq 1 90); do
  BODY=$(curl -fsS "$API/scorecards/$ID" -H 'x-everdict-tenant: default')
  STATUS=$(printf '%s' "$BODY" | field status)
  case "$STATUS" in succeeded | failed | cancelled) break ;; esac
  printf '   waiting … %s\r' "$STATUS"
  sleep 2
done

echo "⑤ verdict               $STATUS"
printf '%s' "$BODY" | field verdictSummary | sed 's/^/   /'
echo
