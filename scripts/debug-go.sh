#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/debug-go.sh --repro "<failing command>" --hypotheses <path> [--auto] [--artifacts-dir <dir>]

Required:
  --repro         Deterministic failing command
  --hypotheses    JSON file with hypothesis experiments

Optional:
  --auto          Skip Gate 1 prompt and run all experiments
  --artifacts-dir Output directory (default: .debug-go/<timestamp>)

Example:
  scripts/debug-go.sh \
    --repro "pnpm -s test --filter=libretto -- test/foo.spec.ts" \
    --hypotheses scripts/debug-go.hypotheses.example.json \
    --auto
EOF
}

REPRO_CMD=""
HYPOTHESES_PATH=""
AUTO_FLAG=""
ARTIFACTS_DIR=""

while (($# > 0)); do
  case "$1" in
    --repro)
      REPRO_CMD="${2:-}"
      shift 2
      ;;
    --hypotheses)
      HYPOTHESES_PATH="${2:-}"
      shift 2
      ;;
    --auto)
      AUTO_FLAG="--auto"
      shift
      ;;
    --artifacts-dir)
      ARTIFACTS_DIR="${2:-}"
      shift 2
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPRO_CMD" || -z "$HYPOTHESES_PATH" ]]; then
  echo "Missing required flags." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$HYPOTHESES_PATH" ]]; then
  echo "Hypotheses file not found: $HYPOTHESES_PATH" >&2
  exit 1
fi

if [[ -z "$ARTIFACTS_DIR" ]]; then
  ARTIFACTS_DIR=".debug-go/$(date +%Y%m%d-%H%M%S)"
fi

mkdir -p "$ARTIFACTS_DIR"
REPRO_LOG="${ARTIFACTS_DIR}/repro.log"

echo "== Step 1: Repro =="
echo "command: $REPRO_CMD"
set +e
bash -lc "$REPRO_CMD" >"$REPRO_LOG" 2>&1
REPRO_EXIT=$?
set -e

if [[ $REPRO_EXIT -eq 0 ]]; then
  echo "Repro command succeeded. No failure to debug. Harden repro first." >&2
  echo "log: $REPRO_LOG"
  exit 2
fi

if [[ "$(<"$REPRO_LOG")" == *"No test files found"* ]]; then
  echo "Repro is invalid: command failed because the target test path does not exist." >&2
  echo "Use a real failing test file or failing command first." >&2
  echo "log: $REPRO_LOG"
  exit 2
fi

if [[ "$(<"$REPRO_LOG")" == *"Executable doesn't exist at"* ]]; then
  echo "Repro failed due to missing Playwright browser binaries, not product logic." >&2
  echo "Install browsers, then rerun the same repro command:" >&2
  echo "  env -u PLAYWRIGHT_BROWSERS_PATH pnpm -s --filter=libretto exec playwright install chromium" >&2
  echo "log: $REPRO_LOG"
  exit 2
fi

echo "Repro failed as expected (exit=$REPRO_EXIT)."
echo "log: $REPRO_LOG"

echo
echo "== Steps 2-6: Hypothesize, gate, run, ship-guard =="
node scripts/debug-go.mjs \
  --hypotheses "$HYPOTHESES_PATH" \
  --artifacts-dir "$ARTIFACTS_DIR" \
  --repro-log "$REPRO_LOG" \
  $AUTO_FLAG
