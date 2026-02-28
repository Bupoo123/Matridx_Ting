#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:8081}"
USERNAME="${USERNAME:-admin}"
PASSWORD="${PASSWORD:-admin123}"
TARGET_DATE="${TARGET_DATE:-$(date +%F)}"
TARGET_TZ="${TARGET_TZ:-$(node -e 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")')}"

echo "[smoke] API_BASE=$API_BASE date=$TARGET_DATE tz=$TARGET_TZ"

curl -fsS "$API_BASE/healthz" >/dev/null

LOGIN_PAYLOAD=$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")
TOKEN=$(
  curl -fsS "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "$LOGIN_PAYLOAD" \
    | node -e 'const chunks=[];process.stdin.on("data",(d)=>chunks.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!j.access_token){process.exit(2);}process.stdout.write(j.access_token);});'
)

AUTH_HEADER="Authorization: Bearer $TOKEN"

curl -fsS "$API_BASE/settings/ai" -H "$AUTH_HEADER" >/dev/null
curl -fsS -X PUT "$API_BASE/users/me/timezone" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "{\"tz\":\"$TARGET_TZ\"}" >/dev/null

curl -fsS "$API_BASE/recordings?date=$TARGET_DATE" -H "$AUTH_HEADER" >/dev/null
curl -fsS "$API_BASE/transcripts?date=$TARGET_DATE" -H "$AUTH_HEADER" >/dev/null
curl -fsS "$API_BASE/meeting-notes?date=$TARGET_DATE" -H "$AUTH_HEADER" >/dev/null
curl -fsS "$API_BASE/daily-summaries?date=$TARGET_DATE" -H "$AUTH_HEADER" >/dev/null

curl -fsS -X POST "$API_BASE/daily-summaries" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"$TARGET_DATE\",\"trigger\":\"manual\"}" >/dev/null

echo "[smoke] PASS"
