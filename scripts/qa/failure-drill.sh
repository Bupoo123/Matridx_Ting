#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:8081}"
USERNAME="${USERNAME:-admin}"
PASSWORD="${PASSWORD:-admin123}"
TARGET_DATE="${TARGET_DATE:-$(date +%F)}"
NOTES_DIR="${NOTES_DIR:-/Users/bupoo/Github/Matridx_Ting/infra/data/notes}"

echo "[drill] API_BASE=$API_BASE date=$TARGET_DATE notes_dir=$NOTES_DIR"

LOGIN_PAYLOAD=$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")
TOKEN=$(
  curl -fsS "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "$LOGIN_PAYLOAD" \
    | node -e 'const chunks=[];process.stdin.on("data",(d)=>chunks.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!j.access_token){process.exit(2);}process.stdout.write(j.access_token);});'
)
AUTH_HEADER="Authorization: Bearer $TOKEN"

mkdir -p "$NOTES_DIR"
chmod -R u+rwX "$NOTES_DIR"

restore_permissions() {
  chmod -R u+rwX "$NOTES_DIR" >/dev/null 2>&1 || true
}
trap restore_permissions EXIT

extract_note_last_error() {
  node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    const recordingId = process.argv[1];
    const rows = JSON.parse(input);
    const row = rows.find((item) => item.recording_id === recordingId);
    process.stdout.write(row?.last_error ? "1" : "0");
  ' "$1"
}

poll_daily_summary_last_error() {
  local expect_error="$1"
  local ok=0
  for _ in $(seq 1 20); do
    local response
    response=$(curl -fsS "$API_BASE/daily-summaries?date=$TARGET_DATE" -H "$AUTH_HEADER")
    local has_error
    has_error=$(node -e '
      const fs = require("fs");
      const input = fs.readFileSync(0, "utf8").trim();
      if (!input || input === "null") {
        process.stdout.write("none");
        process.exit(0);
      }
      const row = JSON.parse(input);
      process.stdout.write(row.last_error ? "1" : "0");
    ' <<<"$response")
    if [[ "$expect_error" == "1" && "$has_error" == "1" ]]; then
      ok=1
      break
    fi
    if [[ "$expect_error" == "0" && "$has_error" == "0" && "$response" != "null" ]]; then
      ok=1
      break
    fi
    sleep 2
  done
  if [[ "$ok" != "1" ]]; then
    echo "[drill] daily summary last_error expectation not met (expected=$expect_error)"
    exit 1
  fi
}

echo "[drill] Step1: make notes dir read-only"
chmod -R u-w "$NOTES_DIR"

RECORDING_ID=$(
  curl -fsS "$API_BASE/recordings?date=$TARGET_DATE" -H "$AUTH_HEADER" \
    | node -e '
      const fs = require("fs");
      const rows = JSON.parse(fs.readFileSync(0, "utf8"));
      const transcribed = rows.find((r) => r.status === "transcribed");
      process.stdout.write((transcribed?.id || "").toString());
    '
)

if [[ -n "$RECORDING_ID" ]]; then
  echo "[drill] Step2: regenerate meeting note with read-only dir"
  curl -fsS -X POST "$API_BASE/meeting-notes/$RECORDING_ID/regenerate" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "{}" >/dev/null
  MEETING_NOTES_JSON=$(curl -fsS "$API_BASE/meeting-notes?date=$TARGET_DATE" -H "$AUTH_HEADER")
  NOTE_HAS_ERROR=$(extract_note_last_error "$RECORDING_ID" <<<"$MEETING_NOTES_JSON")
  if [[ "$NOTE_HAS_ERROR" != "1" ]]; then
    echo "[drill] expected meeting note last_error after read-only failure"
    exit 1
  fi
else
  echo "[drill] no transcribed recording found for date=$TARGET_DATE, skipping meeting-note failure drill"
fi

echo "[drill] Step3: generate daily summary with read-only dir"
curl -fsS -X POST "$API_BASE/daily-summaries" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"$TARGET_DATE\",\"trigger\":\"manual\"}" >/dev/null
poll_daily_summary_last_error "1"

echo "[drill] Step4: restore permissions and regenerate"
chmod -R u+rwX "$NOTES_DIR"

if [[ -n "$RECORDING_ID" ]]; then
  curl -fsS -X POST "$API_BASE/meeting-notes/$RECORDING_ID/regenerate" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "{}" >/dev/null
  MEETING_NOTES_JSON=$(curl -fsS "$API_BASE/meeting-notes?date=$TARGET_DATE" -H "$AUTH_HEADER")
  NOTE_HAS_ERROR=$(extract_note_last_error "$RECORDING_ID" <<<"$MEETING_NOTES_JSON")
  if [[ "$NOTE_HAS_ERROR" != "0" ]]; then
    echo "[drill] meeting note last_error not cleared after regenerate"
    exit 1
  fi
fi

curl -fsS -X POST "$API_BASE/daily-summaries/$TARGET_DATE/regenerate" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "{}" >/dev/null
poll_daily_summary_last_error "0"

echo "[drill] PASS"
