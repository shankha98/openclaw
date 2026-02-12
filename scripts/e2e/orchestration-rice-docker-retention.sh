#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ORCH_EXT_VALIDATE_RETENTION=1
export ORCH_RETENTION="${ORCH_RETENTION:-2m}"

bash "$ROOT_DIR/scripts/e2e/orchestration-rice-docker-extended.sh"
