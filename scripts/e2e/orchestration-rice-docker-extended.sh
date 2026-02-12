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
RETENTION="${ORCH_RETENTION:-7d}"
RUN_RETENTION_PHASE="${ORCH_EXT_VALIDATE_RETENTION:-0}"
RUN_EXTERNAL_DELIVERY_PHASE="${ORCH_EXT_VALIDATE_EXTERNAL_DELIVERY:-0}"
DELIVER_CHANNEL="${ORCH_DELIVER_CHANNEL:-}"
DELIVER_TO="${ORCH_DELIVER_TO:-}"
DELIVER_TIMEOUT_MS="${ORCH_DELIVER_TIMEOUT_MS:-120000}"
MODEL_PRIMARY="${ORCH_MODEL_PRIMARY:-google/gemini-3-flash-preview}"
GEMINI_KEY="${ORCH_GEMINI_API_KEY:-${GEMINI_API_KEY:-}}"
TELEGRAM_TOKEN="${ORCH_TELEGRAM_BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
OPENCLAW_SKIP_CHANNELS="${ORCH_OPENCLAW_SKIP_CHANNELS:-1}"
REQUIRE_OK_RESULTS="${ORCH_REQUIRE_OK_RESULTS:-1}"
HEARTBEAT_INTERVAL="${ORCH_HEARTBEAT_INTERVAL:-2s}"
HEARTBEAT_TTL="${ORCH_HEARTBEAT_TTL:-8s}"
POLL_INTERVAL="${ORCH_POLL_INTERVAL:-2s}"
EXT_CONNECT_TIMEOUT_MS="${ORCH_EXT_CONNECT_TIMEOUT_MS:-60000}"
EXT_STATUS_RPC_TIMEOUT_MS="${ORCH_EXT_STATUS_RPC_TIMEOUT_MS:-20000}"
EXT_DISPATCH_RPC_TIMEOUT_MS="${ORCH_EXT_DISPATCH_RPC_TIMEOUT_MS:-30000}"
EXT_TASK_TIMEOUT_MS="${ORCH_EXT_TASK_TIMEOUT_MS:-120000}"
EXT_LIVE_WAIT_TIMEOUT_MS="${ORCH_EXT_LIVE_WAIT_TIMEOUT_MS:-60000}"
EXT_FAILOVER_OFFLINE_WAIT_TIMEOUT_MS="${ORCH_EXT_FAILOVER_OFFLINE_WAIT_TIMEOUT_MS:-45000}"
EXT_BURST_RESULTS_TIMEOUT_MS="${ORCH_EXT_BURST_RESULTS_TIMEOUT_MS:-180000}"
EXT_OBSERVER_RESULT_TIMEOUT_MS="${ORCH_EXT_OBSERVER_RESULT_TIMEOUT_MS:-6000}"
EXT_EXTERNAL_RESULT_BUFFER_MS="${ORCH_EXT_EXTERNAL_RESULT_BUFFER_MS:-60000}"
EXT_RETENTION_MAX_MS="${ORCH_EXT_RETENTION_MAX_MS:-120000}"
EXT_RETENTION_WAIT_FLOOR_MS="${ORCH_EXT_RETENTION_WAIT_FLOOR_MS:-60000}"
EXT_RETENTION_EXTRA_WAIT_MS="${ORCH_EXT_RETENTION_EXTRA_WAIT_MS:-45000}"
EXT_CONNECT_CHALLENGE_TIMEOUT_MS="${ORCH_EXT_CONNECT_CHALLENGE_TIMEOUT_MS:-1000}"

if [[ -z "$RICE_ENDPOINT" && ( -z "$STATE_URL" || -z "$STORAGE_URL" ) ]]; then
  echo "Missing Rice configuration."
  echo "Provide ORCH_RICE_ENDPOINT, or set STATE_INSTANCE_URL + STORAGE_INSTANCE_URL."
  echo "You can also use ORCH_STATE_INSTANCE_URL + ORCH_STORAGE_INSTANCE_URL."
  exit 1
fi

if [[ "$MODEL_PRIMARY" == google/* && -z "$GEMINI_KEY" ]]; then
  echo "Missing GEMINI_API_KEY (or ORCH_GEMINI_API_KEY) for model $MODEL_PRIMARY."
  exit 1
fi

if [[ "$RUN_EXTERNAL_DELIVERY_PHASE" == "1" ]]; then
  if [[ -z "${ORCH_OPENCLAW_SKIP_CHANNELS:-}" ]]; then
    OPENCLAW_SKIP_CHANNELS="0"
  fi
  if [[ -z "$DELIVER_CHANNEL" || -z "$DELIVER_TO" ]]; then
    echo "Missing delivery target for external delivery phase."
    echo "Set ORCH_DELIVER_CHANNEL and ORCH_DELIVER_TO."
    exit 1
  fi
  if [[ "$DELIVER_CHANNEL" == "telegram" && -z "$TELEGRAM_TOKEN" ]]; then
    echo "Missing Telegram credentials for external delivery phase."
    echo "Set TELEGRAM_BOT_TOKEN (or ORCH_TELEGRAM_BOT_TOKEN)."
    exit 1
  fi
fi

TELEGRAM_CONFIG_JSON=""
if [[ -n "$TELEGRAM_TOKEN" ]]; then
  TELEGRAM_CONFIG_JSON=$(cat <<JSON
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$TELEGRAM_TOKEN",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  },
  "plugins": {
    "entries": {
      "telegram": {
        "enabled": true
      }
    }
  },
JSON
)
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
  ORCH_OPENCLAW_SKIP_CHANNELS="$OPENCLAW_SKIP_CHANNELS" \
  GEMINI_API_KEY="$GEMINI_KEY" \
  TELEGRAM_BOT_TOKEN="$TELEGRAM_TOKEN" \
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
    -e ORCH_RETENTION="$RETENTION" \
    -e ORCH_EXT_VALIDATE_EXTERNAL_DELIVERY="$RUN_EXTERNAL_DELIVERY_PHASE" \
    -e ORCH_DELIVER_CHANNEL="$DELIVER_CHANNEL" \
    -e ORCH_DELIVER_TO="$DELIVER_TO" \
    -e ORCH_DELIVER_TIMEOUT_MS="$DELIVER_TIMEOUT_MS" \
    -e ORCH_REQUIRE_OK_RESULTS="$REQUIRE_OK_RESULTS" \
    -e ORCH_EXT_CONNECT_TIMEOUT_MS="$EXT_CONNECT_TIMEOUT_MS" \
    -e ORCH_EXT_CONNECT_CHALLENGE_TIMEOUT_MS="$EXT_CONNECT_CHALLENGE_TIMEOUT_MS" \
    -e ORCH_EXT_STATUS_RPC_TIMEOUT_MS="$EXT_STATUS_RPC_TIMEOUT_MS" \
    -e ORCH_EXT_DISPATCH_RPC_TIMEOUT_MS="$EXT_DISPATCH_RPC_TIMEOUT_MS" \
    -e ORCH_EXT_TASK_TIMEOUT_MS="$EXT_TASK_TIMEOUT_MS" \
    -e ORCH_EXT_LIVE_WAIT_TIMEOUT_MS="$EXT_LIVE_WAIT_TIMEOUT_MS" \
    -e ORCH_EXT_FAILOVER_OFFLINE_WAIT_TIMEOUT_MS="$EXT_FAILOVER_OFFLINE_WAIT_TIMEOUT_MS" \
    -e ORCH_EXT_BURST_RESULTS_TIMEOUT_MS="$EXT_BURST_RESULTS_TIMEOUT_MS" \
    -e ORCH_EXT_OBSERVER_RESULT_TIMEOUT_MS="$EXT_OBSERVER_RESULT_TIMEOUT_MS" \
    -e ORCH_EXT_EXTERNAL_RESULT_BUFFER_MS="$EXT_EXTERNAL_RESULT_BUFFER_MS" \
    -e ORCH_EXT_RETENTION_MAX_MS="$EXT_RETENTION_MAX_MS" \
    -e ORCH_EXT_RETENTION_WAIT_FLOOR_MS="$EXT_RETENTION_WAIT_FLOOR_MS" \
    -e ORCH_EXT_RETENTION_EXTRA_WAIT_MS="$EXT_RETENTION_EXTRA_WAIT_MS" \
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
  "agents": {
    "defaults": {
      "model": {
        "primary": "$MODEL_PRIMARY"
      }
    }
  },
${TELEGRAM_CONFIG_JSON}
  "orchestration": {
    "enabled": true,
    "role": "orchestrator",
    "clusterId": "$CLUSTER_ID",
    "workers": ["worker-a", "worker-b"],
    "heartbeat": {
      "interval": "$HEARTBEAT_INTERVAL",
      "ttl": "$HEARTBEAT_TTL"
    },
    "poll": {
      "interval": "$POLL_INTERVAL"
    },
    "retention": "$RETENTION",
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
  "agents": {
    "defaults": {
      "model": {
        "primary": "$MODEL_PRIMARY"
      }
    }
  },
${TELEGRAM_CONFIG_JSON}
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-a",
    "heartbeat": {
      "interval": "$HEARTBEAT_INTERVAL",
      "ttl": "$HEARTBEAT_TTL"
    },
    "poll": {
      "interval": "$POLL_INTERVAL"
    },
    "retention": "$RETENTION",
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
  "agents": {
    "defaults": {
      "model": {
        "primary": "$MODEL_PRIMARY"
      }
    }
  },
${TELEGRAM_CONFIG_JSON}
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-b",
    "heartbeat": {
      "interval": "$HEARTBEAT_INTERVAL",
      "ttl": "$HEARTBEAT_TTL"
    },
    "poll": {
      "interval": "$POLL_INTERVAL"
    },
    "retention": "$RETENTION",
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
  "agents": {
    "defaults": {
      "model": {
        "primary": "$MODEL_PRIMARY"
      }
    }
  },
${TELEGRAM_CONFIG_JSON}
  "orchestration": {
    "enabled": true,
    "role": "orchestrator",
    "clusterId": "$CLUSTER_ID",
    "workers": ["worker-a", "worker-b"],
    "heartbeat": {
      "interval": "$HEARTBEAT_INTERVAL",
      "ttl": "$HEARTBEAT_TTL"
    },
    "poll": {
      "interval": "$POLL_INTERVAL"
    },
    "retention": "$RETENTION",
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
  "agents": {
    "defaults": {
      "model": {
        "primary": "$MODEL_PRIMARY"
      }
    }
  },
${TELEGRAM_CONFIG_JSON}
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-a",
    "heartbeat": {
      "interval": "$HEARTBEAT_INTERVAL",
      "ttl": "$HEARTBEAT_TTL"
    },
    "poll": {
      "interval": "$POLL_INTERVAL"
    },
    "retention": "$RETENTION",
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
  "agents": {
    "defaults": {
      "model": {
        "primary": "$MODEL_PRIMARY"
      }
    }
  },
${TELEGRAM_CONFIG_JSON}
  "orchestration": {
    "enabled": true,
    "role": "worker",
    "clusterId": "$CLUSTER_ID",
    "workerId": "worker-b",
    "heartbeat": {
      "interval": "$HEARTBEAT_INTERVAL",
      "ttl": "$HEARTBEAT_TTL"
    },
    "poll": {
      "interval": "$POLL_INTERVAL"
    },
    "retention": "$RETENTION",
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

if [[ "$RUN_RETENTION_PHASE" == "1" ]]; then
  run_phase retention-cleanup
fi

if [[ "$RUN_EXTERNAL_DELIVERY_PHASE" == "1" ]]; then
  run_phase external-delivery
fi

echo "Extended orchestration docker acceptance passed"
