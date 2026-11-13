#!/usr/bin/env bash
# A recorded stack is only driven. With no stack, launch, drive, and clean up.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
STEP="${1:-all}"
STATE="$ROOT/output/qa/verify/state.json"
cd "$ROOT"

if [[ -f "$STATE" ]]; then
  node "$ROOT/.cursor/skills/verify-pirate-radio/drive.mjs" "$STEP"
  exit
fi

bash "$ROOT/.cursor/skills/verify-pirate-radio/verify.sh" launch
status=0
node "$ROOT/.cursor/skills/verify-pirate-radio/drive.mjs" "$STEP" || status=$?
cleanup_status=0
bash "$ROOT/.cursor/skills/verify-pirate-radio/verify.sh" cleanup || cleanup_status=$?
if [[ "$status" -eq 0 ]]; then
  status=$cleanup_status
fi
exit "$status"
