#!/usr/bin/env bash
set -euo pipefail

BASE=${BASE_URL:-http://localhost:3000}
JQ=${JQ:-jq}

echo "Health:"
curl -sS "${BASE}/api/health" | ${JQ:-cat}

echo
echo "Spot prices (latest):"
curl -sS "${BASE}/api/spot-prices" | ${JQ:-cat}

echo
echo "Create alert:"
RES=$(curl -sS -X POST "${BASE}/api/alerts" -H "Content-Type: application/json" -d '{"cloud":"TEST","vmType":"small","region":"local","thresholdPrice":1,"notifyEmail":"test@example.com"}')
echo "$RES" | ${JQ:-cat}
ID=$(echo "$RES" | ${JQ} -r .id 2>/dev/null || echo "null")
echo "Created alert id=$ID"

echo
echo "List alerts:"
curl -sS "${BASE}/api/alerts" | ${JQ:-cat}

if [ "$ID" != "null" ]; then
  echo
  echo "Delete alert $ID"
  curl -sS -X DELETE "${BASE}/api/alerts/$ID" | ${JQ:-cat}
fi

echo
echo "History (none expected):"
curl -sS "${BASE}/api/history?cloud=TEST&vmType=small&region=local&days=7" | ${JQ:-cat}

echo
echo "Done."
