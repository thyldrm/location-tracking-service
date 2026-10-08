#!/usr/bin/env bash
# End-to-end smoke test of a deployment (e.g. on a local kind cluster): creates an area through the API, sends
# pings from inside it and waits until the entry shows up in GET /logs. Every hop is exercised: the API, Kafka,
# the outbox relay, the worker's area index and entry detection, PostgreSQL.
#
#   deploy/k8s/smoke-test.sh [namespace] [api-key]
set -euo pipefail

namespace="${1:-location-tracking}"
api_key="${2:-local-development-api-key-change-me-0123456789}"
port=18080
url="http://127.0.0.1:${port}"

kubectl -n "$namespace" port-forward svc/location-tracking-api "${port}:80" >/dev/null 2>&1 &
port_forward=$!
trap 'kill "$port_forward" 2>/dev/null || true' EXIT

for _ in $(seq 30); do
  curl -sf "${url}/health/ready" >/dev/null && break
  sleep 1
done

run="smoke-$(date +%s)"
curl -sf -X POST "${url}/areas" \
  -H "x-api-key: ${api_key}" -H 'content-type: application/json' \
  -d "{\"name\":\"${run}\",\"geometry\":{\"type\":\"Polygon\",\"coordinates\":[[[50,50],[51,50],[51,51],[50,51],[50,50]]]}}" \
  >/dev/null
echo "area ${run} created"

# One ping per second from inside the area, until the worker knows the area and records the entry.
for attempt in $(seq 60); do
  curl -sf -X POST "${url}/locations" \
    -H "x-api-key: ${api_key}" -H 'content-type: application/json' \
    -d "{\"userId\":\"${run}\",\"latitude\":50.5,\"longitude\":50.5,\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    >/dev/null
  logs=$(curl -sf "${url}/logs?userId=${run}" -H "x-api-key: ${api_key}")
  if [[ "$logs" == *"\"userId\":\"${run}\""* ]]; then
    echo "entry recorded after ${attempt} ping(s): ${logs}"
    exit 0
  fi
  sleep 1
done

echo "no entry was recorded within 60 s" >&2
exit 1
