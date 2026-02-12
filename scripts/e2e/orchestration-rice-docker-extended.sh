#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.orchestration.yml"
IMAGE_NAME="${ORCH_OPENCLAW_IMAGE:-openclaw-orchestration-e2e}"
SKIP_BUILD="${ORCH_SKIP_BUILD:-0}"
ORCH_PORT="${ORCH_ORCHESTRATOR_PORT:-18889}"
GATEWAY_TOKEN="${ORCH_GATEWAY_TOKEN:-orch-extended-e2e-$(date +%s)-$$}"
CLUSTER_ID="${ORCH_CLUSTER_ID:-local-dev}"
RUN_ID="${ORCH_RUN_ID:-openclaw-orchestration-extended-e2e-$$}"
RICE_ENDPOINT="${ORCH_RICE_ENDPOINT:-}"
STATE_URL="${ORCH_STATE_INSTANCE_URL:-${STATE_INSTANCE_URL:-}}"
STATE_TOKEN="${ORCH_STATE_AUTH_TOKEN:-${STATE_AUTH_TOKEN:-}}"
STORAGE_URL="${ORCH_STORAGE_INSTANCE_URL:-${STORAGE_INSTANCE_URL:-}}"
STORAGE_TOKEN="${ORCH_STORAGE_AUTH_TOKEN:-${STORAGE_AUTH_TOKEN:-}}"
RICE_STORAGE_HTTP_PORT="${ORCH_STORAGE_HTTP_PORT:-${STORAGE_HTTP_PORT:-}}"
BURST_COUNT="${ORCH_BURST_COUNT:-24}"

if [[ -z "$RICE_ENDPOINT" && ( -z "$STATE_URL" || -z "$STORAGE_URL" ) ]]; then
  echo "Missing Rice configuration."
  echo "Provide ORCH_RICE_ENDPOINT, or set STATE_INSTANCE_URL + STORAGE_INSTANCE_URL."
  echo "You can also use ORCH_STATE_INSTANCE_URL + ORCH_STORAGE_INSTANCE_URL."
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-orchestration-extended-e2e.XXXXXX")"
PROJECT="openclaw-orchestration-extended-e2e-$RANDOM"

compose_cmd() {
  OPENCLAW_IMAGE="$IMAGE_NAME" \
  ORCH_CONFIG_ROOT="$WORK_DIR" \
  ORCH_ORCHESTRATOR_PORT="$ORCH_PORT" \
  STATE_INSTANCE_URL="$STATE_URL" \
  STATE_AUTH_TOKEN="$STATE_TOKEN" \
  STORAGE_INSTANCE_URL="$STORAGE_URL" \
  STORAGE_AUTH_TOKEN="$STORAGE_TOKEN" \
  STORAGE_HTTP_PORT="$RICE_STORAGE_HTTP_PORT" \
    docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" "$@"
}

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "--- docker compose logs (last 180 lines per service) ---"
    compose_cmd logs --tail 180 || true
  fi
  compose_cmd down -v >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
  return "$exit_code"
}
trap cleanup EXIT

wait_for_port() {
  local port="$1"
  local ready=0
  for _ in $(seq 1 120); do
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "Orchestrator did not open port $port"
    exit 1
  fi
}

run_phase() {
  local phase="$1"
  echo "Running extended orchestration phase: $phase"
  compose_cmd exec -T \
    -e ORCH_EXT_PHASE="$phase" \
    -e ORCH_GATEWAY_URL="ws://127.0.0.1:18789" \
    -e ORCH_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
    -e ORCH_RUN_ID="$RUN_ID" \
    -e ORCH_RICE_ENDPOINT="$RICE_ENDPOINT" \
    -e ORCH_STATE_INSTANCE_URL="$STATE_URL" \
    -e ORCH_STATE_AUTH_TOKEN="$STATE_TOKEN" \
    -e ORCH_STORAGE_INSTANCE_URL="$STORAGE_URL" \
    -e ORCH_STORAGE_AUTH_TOKEN="$STORAGE_TOKEN" \
    -e ORCH_STORAGE_HTTP_PORT="$RICE_STORAGE_HTTP_PORT" \
    -e ORCH_BURST_COUNT="$BURST_COUNT" \
    orchestrator \
    node --import tsx /app/scripts/e2e/orchestration-rice-extended-check.ts
}

mkdir -p "$WORK_DIR"/orchestrator "$WORK_DIR"/worker-a "$WORK_DIR"/worker-b "$WORK_DIR"/workspace

if [[ -n "$RICE_ENDPOINT" ]]; then
  echo "Rice mode: single endpoint override"
  cat > "$WORK_DIR/orchestrator/openclaw.json" <<JSON
{
  "gateway": {
    "auth": {
      "token": "$GATEWAY_TOKEN"
    }
  },
  "orchestration": {
    "enabled": true,
    "role": "orchestrator",
    "clusterId": "$CLUSTER_ID",
    "workers": ["worker-a", "worker-b"],
    "heartbeat": {
      "interval": "2s",
      "ttl": "8s"
    },
    "poll": {
      "interval": "2s"
    },
    "retention": "7d",
    "rice": {
      "runId": "$RUN_ID",
      "endpoint": "$RICE_ENDPOINT"
    }
  }
}
JSON

  cat > "$WORK_DIR/worker-a/openclaw.json" <<JSON
{
  "gateway": {
    "auth": {
      "token": "$GATEWAY_TOKEN"
    }
  },
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-a",
    "heartbeat": {
      "interval": "2s",
      "ttl": "8s"
    },
    "poll": {
      "interval": "2s"
    },
    "retention": "7d",
    "rice": {
      "runId": "$RUN_ID",
      "endpoint": "$RICE_ENDPOINT"
    }
  }
}
JSON

  cat > "$WORK_DIR/worker-b/openclaw.json" <<JSON
{
  "gateway": {
    "auth": {
      "token": "$GATEWAY_TOKEN"
    }
  },
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-b",
    "heartbeat": {
      "interval": "2s",
      "ttl": "8s"
    },
    "poll": {
      "interval": "2s"
    },
    "retention": "7d",
    "rice": {
      "runId": "$RUN_ID",
      "endpoint": "$RICE_ENDPOINT"
    }
  }
}
JSON
else
  echo "Rice mode: split state/storage endpoints from environment"
  cat > "$WORK_DIR/orchestrator/openclaw.json" <<JSON
{
  "gateway": {
    "auth": {
      "token": "$GATEWAY_TOKEN"
    }
  },
  "orchestration": {
    "enabled": true,
    "role": "orchestrator",
    "clusterId": "$CLUSTER_ID",
    "workers": ["worker-a", "worker-b"],
    "heartbeat": {
      "interval": "2s",
      "ttl": "8s"
    },
    "poll": {
      "interval": "2s"
    },
    "retention": "7d",
    "rice": {
      "runId": "$RUN_ID"
    }
  }
}
JSON

  cat > "$WORK_DIR/worker-a/openclaw.json" <<JSON
{
  "gateway": {
    "auth": {
      "token": "$GATEWAY_TOKEN"
    }
  },
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-a",
    "heartbeat": {
      "interval": "2s",
      "ttl": "8s"
    },
    "poll": {
      "interval": "2s"
    },
    "retention": "7d",
    "rice": {
      "runId": "$RUN_ID"
    }
  }
}
JSON

  cat > "$WORK_DIR/worker-b/openclaw.json" <<JSON
{
  "gateway": {
    "auth": {
      "token": "$GATEWAY_TOKEN"
    }
  },
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-b",
    "heartbeat": {
      "interval": "2s",
      "ttl": "8s"
    },
    "poll": {
      "interval": "2s"
    },
    "retention": "7d",
    "rice": {
      "runId": "$RUN_ID"
    }
  }
}
JSON
fi

if [[ "$SKIP_BUILD" == "1" ]]; then
  echo "Skipping Docker build (ORCH_SKIP_BUILD=1), using image: $IMAGE_NAME"
else
  echo "Building Docker image: $IMAGE_NAME"
  docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" >/dev/null
fi

echo "Starting orchestrator + 2 workers"
compose_cmd up -d >/dev/null

echo "Waiting for orchestrator port $ORCH_PORT"
wait_for_port "$ORCH_PORT"
sleep 1

run_phase baseline

echo "Stopping worker-b for failover checks"
compose_cmd stop worker-b >/dev/null
run_phase worker-b-down

echo "Starting worker-b for recovery checks"
compose_cmd start worker-b >/dev/null
run_phase worker-b-up

echo "Restarting orchestrator for resilience checks"
compose_cmd restart orchestrator >/dev/null
wait_for_port "$ORCH_PORT"
sleep 1
run_phase post-orchestrator-restart

echo "Extended orchestration docker acceptance passed"
