#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -z "${ORCH_DELIVER_CHANNEL:-}" || -z "${ORCH_DELIVER_TO:-}" ]]; then
  echo "Missing ORCH_DELIVER_CHANNEL or ORCH_DELIVER_TO."
  echo "Example:"
  echo "  ORCH_DELIVER_CHANNEL=telegram ORCH_DELIVER_TO=123456789 bash scripts/e2e/orchestration-rice-docker-external-delivery.sh"
  exit 1
fi

export ORCH_EXT_VALIDATE_EXTERNAL_DELIVERY=1
export ORCH_OPENCLAW_SKIP_CHANNELS="${ORCH_OPENCLAW_SKIP_CHANNELS:-0}"
export ORCH_RETENTION="${ORCH_RETENTION:-2m}"

bash "$ROOT_DIR/scripts/e2e/orchestration-rice-docker-extended.sh"
