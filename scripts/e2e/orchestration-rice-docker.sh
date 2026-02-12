#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.orchestration.yml"
IMAGE_NAME="${ORCH_OPENCLAW_IMAGE:-openclaw-orchestration-e2e}"
SKIP_BUILD="${ORCH_SKIP_BUILD:-0}"
ORCH_PORT="${ORCH_ORCHESTRATOR_PORT:-18889}"
GATEWAY_TOKEN="${ORCH_GATEWAY_TOKEN:-orch-e2e-$(date +%s)-$$}"
CLUSTER_ID="${ORCH_CLUSTER_ID:-local-dev}"
RUN_ID="${ORCH_RUN_ID:-openclaw-orchestration-e2e-$$}"
RICE_ENDPOINT="${ORCH_RICE_ENDPOINT:-}"
STATE_URL="${ORCH_STATE_INSTANCE_URL:-${STATE_INSTANCE_URL:-}}"
STATE_TOKEN="${ORCH_STATE_AUTH_TOKEN:-${STATE_AUTH_TOKEN:-}}"
STORAGE_URL="${ORCH_STORAGE_INSTANCE_URL:-${STORAGE_INSTANCE_URL:-}}"
STORAGE_TOKEN="${ORCH_STORAGE_AUTH_TOKEN:-${STORAGE_AUTH_TOKEN:-}}"
RICE_STORAGE_HTTP_PORT="${ORCH_STORAGE_HTTP_PORT:-${STORAGE_HTTP_PORT:-}}"

if [[ -z "$RICE_ENDPOINT" && ( -z "$STATE_URL" || -z "$STORAGE_URL" ) ]]; then
  echo "Missing Rice configuration."
  echo "Provide ORCH_RICE_ENDPOINT, or set STATE_INSTANCE_URL + STORAGE_INSTANCE_URL."
  echo "You can also use ORCH_STATE_INSTANCE_URL + ORCH_STORAGE_INSTANCE_URL."
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-orchestration-e2e.XXXXXX")"
PROJECT="openclaw-orchestration-e2e-$RANDOM"
FAILED=0

cleanup() {
  local exit_code=$?
  if [[ $FAILED -ne 0 || $exit_code -ne 0 ]]; then
    echo "--- docker compose logs (last 120 lines per service) ---"
    OPENCLAW_IMAGE="$IMAGE_NAME" \
    ORCH_CONFIG_ROOT="$WORK_DIR" \
    ORCH_ORCHESTRATOR_PORT="$ORCH_PORT" \
    STATE_INSTANCE_URL="$STATE_URL" \
    STATE_AUTH_TOKEN="$STATE_TOKEN" \
    STORAGE_INSTANCE_URL="$STORAGE_URL" \
    STORAGE_AUTH_TOKEN="$STORAGE_TOKEN" \
    STORAGE_HTTP_PORT="$RICE_STORAGE_HTTP_PORT" \
      docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" logs --tail 120 || true
  fi
  OPENCLAW_IMAGE="$IMAGE_NAME" \
  ORCH_CONFIG_ROOT="$WORK_DIR" \
  ORCH_ORCHESTRATOR_PORT="$ORCH_PORT" \
  STATE_INSTANCE_URL="$STATE_URL" \
  STATE_AUTH_TOKEN="$STATE_TOKEN" \
  STORAGE_INSTANCE_URL="$STORAGE_URL" \
  STORAGE_AUTH_TOKEN="$STORAGE_TOKEN" \
  STORAGE_HTTP_PORT="$RICE_STORAGE_HTTP_PORT" \
    docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" down -v >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
  return "$exit_code"
}
trap cleanup EXIT

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
OPENCLAW_IMAGE="$IMAGE_NAME" \
ORCH_CONFIG_ROOT="$WORK_DIR" \
ORCH_ORCHESTRATOR_PORT="$ORCH_PORT" \
STATE_INSTANCE_URL="$STATE_URL" \
STATE_AUTH_TOKEN="$STATE_TOKEN" \
STORAGE_INSTANCE_URL="$STORAGE_URL" \
STORAGE_AUTH_TOKEN="$STORAGE_TOKEN" \
STORAGE_HTTP_PORT="$RICE_STORAGE_HTTP_PORT" \
  docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" up -d >/dev/null

echo "Waiting for orchestrator port $ORCH_PORT"
ready=0
for _ in $(seq 1 80); do
  if nc -z 127.0.0.1 "$ORCH_PORT" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ "$ready" -ne 1 ]]; then
  echo "Orchestrator did not open port $ORCH_PORT"
  FAILED=1
  exit 1
fi

# Give the gateway a short grace period after the port opens to finish startup.
sleep 1

echo "Running orchestration acceptance checks"
ORCH_GATEWAY_URL="ws://127.0.0.1:${ORCH_PORT}" \
ORCH_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
ORCH_RUN_ID="$RUN_ID" \
ORCH_RICE_ENDPOINT="$RICE_ENDPOINT" \
ORCH_STATE_INSTANCE_URL="$STATE_URL" \
ORCH_STATE_AUTH_TOKEN="$STATE_TOKEN" \
ORCH_STORAGE_INSTANCE_URL="$STORAGE_URL" \
ORCH_STORAGE_AUTH_TOKEN="$STORAGE_TOKEN" \
ORCH_STORAGE_HTTP_PORT="$RICE_STORAGE_HTTP_PORT" \
  node --import tsx - <<'NODE'
import { WebSocket } from "ws";
import { Client } from "rice-node-sdk";
import { PROTOCOL_VERSION } from "./src/gateway/protocol/index.ts";
import { ensureRiceSdkConfigPath } from "./src/memory/rice-sdk-config.ts";

const gatewayUrl = process.env.ORCH_GATEWAY_URL;
const gatewayToken = process.env.ORCH_GATEWAY_TOKEN;
const runId = process.env.ORCH_RUN_ID;
const riceEndpoint = process.env.ORCH_RICE_ENDPOINT?.trim();
const stateInstanceUrl = process.env.ORCH_STATE_INSTANCE_URL?.trim();
const stateAuthToken = process.env.ORCH_STATE_AUTH_TOKEN?.trim();
const storageInstanceUrl = process.env.ORCH_STORAGE_INSTANCE_URL?.trim();
const storageAuthToken = process.env.ORCH_STORAGE_AUTH_TOKEN?.trim();
const storageHttpPort = process.env.ORCH_STORAGE_HTTP_PORT?.trim();
if (!gatewayUrl || !gatewayToken || !runId) {
  throw new Error("missing ORCH_GATEWAY_URL/ORCH_GATEWAY_TOKEN/ORCH_RUN_ID");
}
if (!riceEndpoint && (!stateInstanceUrl || !storageInstanceUrl)) {
  throw new Error(
    "missing Rice connection info: set ORCH_RICE_ENDPOINT or ORCH_STATE_INSTANCE_URL + ORCH_STORAGE_INSTANCE_URL",
  );
}

async function openWebSocketWithRetry(url, attempts = 20, delayMs = 500) {
  function waitForChallenge(socket, timeoutMs = 8_000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off("message", onMessage);
        socket.off("close", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("connect.challenge timeout"));
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        cleanup();
        reject(new Error("socket closed before connect.challenge"));
      };
      const onMessage = (data) => {
        let obj = null;
        try {
          obj = JSON.parse(String(data));
        } catch {
          return;
        }
        if (obj?.type !== "event" || obj?.event !== "connect.challenge") {
          return;
        }
        clearTimeout(timer);
        cleanup();
        resolve(undefined);
      };
      socket.on("message", onMessage);
      socket.once("close", onClose);
    });
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const socket = new WebSocket(url);
    socket.on("error", () => {
      // Keep process alive on transient socket resets; retry logic handles failures.
    });
    const challengePromise = waitForChallenge(socket);
    try {
      const openPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000);
        socket.once("open", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      await Promise.all([openPromise, challengePromise]);
      if (attempt > 1) {
        console.log(`[e2e] websocket open on retry attempt ${attempt}`);
      } else {
        console.log("[e2e] websocket open");
      }
      return socket;
    } catch (err) {
      lastError = err;
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      if (attempt === attempts) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error("ws open failed");
}

const ws = await openWebSocketWithRetry(gatewayUrl);

function onceFrame(filter, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("frame timeout"));
    }, timeoutMs);
    const onMessage = (data) => {
      const obj = JSON.parse(String(data));
      if (!filter(obj)) {
        return;
      }
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(obj);
    };
    ws.on("message", onMessage);
  });
}

let reqSeq = 0;
async function rpc(method, params = {}, timeoutMs = 20_000) {
  const id = `r${++reqSeq}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await onceFrame((obj) => obj?.type === "res" && obj?.id === id, timeoutMs);
}

const connect = await rpc("connect", {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id: "test",
    displayName: "orchestration-docker-e2e",
    version: "dev",
    platform: process.platform,
    mode: "test",
  },
  role: "operator",
  scopes: ["operator.read", "operator.write", "operator.admin"],
  caps: [],
  auth: { token: gatewayToken },
});
if (!connect.ok) {
  throw new Error(`connect failed: ${connect.error?.message ?? "unknown"}`);
}
console.log("[e2e] connect ok");

let statusPayload = null;
const statusDeadline = Date.now() + 30_000;
while (Date.now() < statusDeadline) {
  const status = await rpc("orchestration.status", {});
  if (!status.ok) {
    throw new Error(`orchestration.status failed: ${status.error?.message ?? "unknown"}`);
  }
  statusPayload = status.payload;
  const live = Array.isArray(statusPayload?.liveWorkers) ? statusPayload.liveWorkers : [];
  console.log("[e2e] live workers:", live.join(","));
  if (live.includes("worker-a") && live.includes("worker-b")) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!statusPayload) {
  throw new Error("missing orchestration.status payload");
}
if (!statusPayload.liveWorkers?.includes("worker-a") || !statusPayload.liveWorkers?.includes("worker-b")) {
  throw new Error(`workers never became live: ${JSON.stringify(statusPayload)}`);
}

const idem1 = `idem-${Date.now()}`;
const dispatch1 = await rpc("orchestration.dispatch", {
  idempotencyKey: idem1,
  message: "orchestration e2e task one",
  sessionKey: "agent:main:main",
  deliver: false,
  timeoutMs: 120000,
});
if (!dispatch1.ok) {
  throw new Error(`dispatch1 failed: ${dispatch1.error?.message ?? "unknown"}`);
}
if (dispatch1.payload?.status !== "accepted") {
  throw new Error(`dispatch1 expected accepted, got: ${JSON.stringify(dispatch1.payload)}`);
}
console.log("[e2e] dispatch1 accepted");
const taskId1 = String(dispatch1.payload?.taskId ?? "");
const worker1 = String(dispatch1.payload?.targetWorkerId ?? "");
if (!taskId1 || !worker1) {
  throw new Error(`dispatch1 missing task/worker: ${JSON.stringify(dispatch1.payload)}`);
}

const result1 = await onceFrame(
  (obj) => obj?.type === "event" && obj?.event === "orchestration.result" && obj?.payload?.taskId === taskId1,
  120_000,
);
if (!result1.payload || result1.payload.taskId !== taskId1) {
  throw new Error(`missing result event for task ${taskId1}`);
}
console.log("[e2e] result1 received");

const dedupe = await rpc("orchestration.dispatch", {
  idempotencyKey: idem1,
  message: "orchestration e2e task one",
  sessionKey: "agent:main:main",
  deliver: false,
});
if (!dedupe.ok) {
  throw new Error(`dedupe dispatch failed: ${dedupe.error?.message ?? "unknown"}`);
}
if (dedupe.payload?.status !== "deduped") {
  throw new Error(`expected deduped response: ${JSON.stringify(dedupe.payload)}`);
}
if (dedupe.payload?.taskId !== taskId1) {
  throw new Error(`dedupe taskId mismatch: ${JSON.stringify(dedupe.payload)}`);
}
console.log("[e2e] dedupe verified");

const idem2 = `${idem1}-2`;
const dispatch2 = await rpc("orchestration.dispatch", {
  idempotencyKey: idem2,
  message: "orchestration e2e task two",
  sessionKey: "agent:main:main",
  deliver: false,
});
if (!dispatch2.ok) {
  throw new Error(`dispatch2 failed: ${dispatch2.error?.message ?? "unknown"}`);
}
if (dispatch2.payload?.status !== "accepted") {
  throw new Error(`dispatch2 expected accepted, got: ${JSON.stringify(dispatch2.payload)}`);
}
const taskId2 = String(dispatch2.payload?.taskId ?? "");
const worker2 = String(dispatch2.payload?.targetWorkerId ?? "");
if (!taskId2 || !worker2) {
  throw new Error(`dispatch2 missing task/worker: ${JSON.stringify(dispatch2.payload)}`);
}
if (worker1 === worker2) {
  throw new Error(`round-robin failed: both dispatches routed to ${worker1}`);
}
console.log("[e2e] dispatch2 accepted with different worker");

await onceFrame(
  (obj) => obj?.type === "event" && obj?.event === "orchestration.result" && obj?.payload?.taskId === taskId2,
  120_000,
);
console.log("[e2e] result2 received");

if (riceEndpoint) {
  process.env.STATE_INSTANCE_URL = riceEndpoint;
  process.env.STORAGE_INSTANCE_URL = riceEndpoint;
} else {
  process.env.STATE_INSTANCE_URL = stateInstanceUrl;
  process.env.STORAGE_INSTANCE_URL = storageInstanceUrl;
}
if (stateAuthToken) {
  process.env.STATE_AUTH_TOKEN = stateAuthToken;
}
if (storageAuthToken) {
  process.env.STORAGE_AUTH_TOKEN = storageAuthToken;
}
if (storageHttpPort) {
  process.env.STORAGE_HTTP_PORT = storageHttpPort;
}
const riceConfigPath = await ensureRiceSdkConfigPath();
const rice = new Client({
  configPath: riceConfigPath,
  runId,
  stateRunId: runId,
  storageRunId: runId,
});
await rice.connect();
const resultVar = await rice.state.getVariable(`oc.orch.result.${taskId1}`);
if (!resultVar || resultVar.name !== `oc.orch.result.${taskId1}`) {
  throw new Error(`result variable missing for task ${taskId1}`);
}
console.log("[e2e] rice result variable verified");

ws.close();
NODE

echo "Orchestration docker acceptance passed"
FAILED=0
