#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

RESULT=$(pnpm --filter @matridx/worker exec tsx -e '
  import { resolveQwenSttDispatchMode } from "./src/providers/openai.ts";
  const samples = [299999, 300000, 300001];
  const output = samples.map((duration) => `${duration}:${resolveQwenSttDispatchMode(duration)}`);
  console.log(output.join(","));
')

EXPECTED="299999:short_inline,300000:short_inline,300001:long_filetrans"
if [ "$RESULT" != "$EXPECTED" ]; then
  echo "[dispatch-boundary] unexpected result: $RESULT"
  exit 1
fi

echo "[dispatch-boundary] PASS $RESULT"
