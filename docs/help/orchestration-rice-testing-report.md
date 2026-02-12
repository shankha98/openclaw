---
summary: "Extended orchestration validation report for Rice state pubsub across multiple OpenClaw instances"
read_when:
  - You want the latest multi-instance orchestration validation evidence
  - You need case by case expectations and observed outcomes
  - You want to understand how Rice state is used in each orchestration path
title: "Orchestration Rice Testing Report"
---

# Orchestration Rice Testing Report

This report captures local Docker validation for orchestration with one orchestrator and two workers,
using external Rice endpoints.

Run date: February 12, 2026

## Scope and setup

- Topology: `1 orchestrator + 2 workers (worker-a, worker-b)`
- Transport: Rice State variables + `VariableUpdate` subscription + periodic `listVariables` reconciliation
- Delivery model: at least once with idempotency dedupe
- Gateway orchestration surface:
  - Methods: `orchestration.dispatch`, `orchestration.status`
  - Event: `orchestration.result`
- Entrypoints used:
  - Standard acceptance: `scripts/e2e/orchestration-rice-docker.sh`
  - Extended acceptance: `scripts/e2e/orchestration-rice-docker-extended.sh`

Command used for the extended run:

```bash
make test-docker-orchestration-rice-extended \
  ENV_FILE=/path/to/.env \
  ORCH_ORCHESTRATOR_PORT=19889 \
  ORCH_BURST_COUNT=8
```

Command used for retention cleanup validation:

```bash
make test-docker-orchestration-rice-retention \
  ENV_FILE=/path/to/.env \
  ORCH_ORCHESTRATOR_PORT=19889 \
  ORCH_BURST_COUNT=8 \
  ORCH_RETENTION=20s
```

## Final run result summary

- Standard orchestration acceptance: `PASSED`
- Extended orchestration acceptance: `PASSED`
- Retention cleanup acceptance (short retention): `PASSED`
- Final marker: `Extended orchestration docker acceptance passed`

Observed during the successful run:

- Baseline primary connect required retries (`connected on retry attempt 20`).
- Post restart connect also required retries (`connected on retry attempt 2`).
- Rice client logs showed gRPC fallback to HTTP followed by successful login.
- `VariableUpdate` stream errors were observed, but orchestration still passed due reconciliation polling.
- Retention phase marker observed: `[extended] retention cleanup verified (retention=20s)`.

## Case matrix

### 1) Worker liveness and status discovery

- Aspect tested: heartbeat publication and liveness detection
- Expectation:
  - both workers appear in `orchestration.status.liveWorkers`
- Result: `PASS`
- Rice usage:
  - workers write heartbeat variables:
    - `oc.orch.worker.worker-a.heartbeat`
    - `oc.orch.worker.worker-b.heartbeat`
  - orchestrator reads heartbeat state via subscribe + periodic reconciliation

### 2) Targeted split workflow on separate workers

- Aspect tested: explicit worker routing for two related steps
- Expectation:
  - step A routes to `worker-a`
  - step B routes to `worker-b`
  - both emit `orchestration.result`
- Result: `PASS`
- Rice usage:
  - orchestrator writes task variables:
    - `oc.orch.task.<taskId>`
  - workers consume task variables and write results:
    - `oc.orch.result.<taskId>`

### 3) Requester result fanout isolation

- Aspect tested: requester scoped event delivery behavior
- Expectation:
  - dispatching connection receives `orchestration.result`
  - second operator connection does not receive requester scoped result for that task
- Result: `PASS`
- Rice usage:
  - result source remains Rice variable write (`oc.orch.result.<taskId>`)
  - event fanout comes from orchestrator reaction to result variable updates

### 4) Burst round robin fairness

- Aspect tested: untargeted routing under concurrent load
- Expectation:
  - both workers receive tasks
  - worker assignment stays balanced (`abs(countA - countB) <= 1`)
  - all result events are observed
- Result: `PASS` (burst count `8`)
- Rice usage:
  - repeated task writes (`oc.orch.task.*`)
  - repeated result writes (`oc.orch.result.*`)
  - selection based on live heartbeats in Rice state

### 5) Idempotency dedupe under contention

- Aspect tested: duplicate dispatch protection
- Expectation:
  - first request `accepted`
  - subsequent same key requests `deduped`
  - all map to one `taskId`
- Result: `PASS`
- Rice usage:
  - orchestrator checks and writes idempotency record:
    - `oc.orch.idem.<sha256(idempotencyKey)>`
  - duplicates read existing idempotency variable and return prior mapping

### 6) Result persistence verification

- Aspect tested: durable result state after completion
- Expectation:
  - `oc.orch.result.<taskId>` exists in Rice state
- Result: `PASS`
- Rice usage:
  - direct `state.getVariable("oc.orch.result.<taskId>")` check after task completion

### 7) Worker down failover and liveness gating

- Aspect tested: heartbeat TTL gating + failover
- Setup:
  - `worker-b` stopped
  - wait until TTL marks `worker-b` offline
- Expectation:
  - targeted dispatch to `worker-b` fails with not live error
  - untargeted dispatches route to `worker-a` only
  - results continue arriving
- Result: `PASS`
- Rice usage:
  - liveness inferred from age of `oc.orch.worker.worker-b.heartbeat`
  - worker selection uses live heartbeat set from Rice state

### 8) Worker recovery

- Aspect tested: rejoin behavior after downtime
- Setup:
  - restart `worker-b`
  - wait until both workers become live again
- Expectation:
  - targeted task to `worker-b` succeeds
  - targeted task to `worker-a` succeeds
- Result: `PASS`
- Rice usage:
  - resumed heartbeat updates from `worker-b`
  - orchestrator status and routing rehydrate from Rice heartbeat state

### 9) Orchestrator restart resilience

- Aspect tested: orchestrator restart and continuity
- Setup:
  - restart orchestrator container
- Expectation:
  - reconnect succeeds
  - workers are still seen as live
  - new dispatch and result flow continue
- Result: `PASS`
- Rice usage:
  - orchestrator restores live view via `listVariables` reconciliation on startup
  - ongoing task/result/heartbeat paths continue on same `runId`

### 10) Retention cleanup lifecycle (Docker + real Rice)

- Aspect tested: expiry cleanup for orchestration task/result/idempotency keys
- Setup:
  - run extended flow with `ORCH_RETENTION=20s`
  - execute retention phase after baseline/failover/recovery/restart checks
- Expectation:
  - `oc.orch.task.<taskId>` expires
  - `oc.orch.result.<taskId>` expires
  - `oc.orch.idem.<sha256(idempotencyKey)>` expires
- Result: `PASS`
- Rice usage:
  - checker reads variable presence via `state.getVariable`
  - cleanup is verified by polling until all three keys are absent

## Additional coverage for previously unvalidated areas

### A) Model/tool output correctness (worker execution path)

- Aspect tested: worker can execute a real tool call loop and return correct content
- Test:
  - `src/orchestration/worker.quality.e2e.test.ts`
  - Run command:
    - `pnpm vitest run --config vitest.e2e.config.ts src/orchestration/worker.quality.e2e.test.ts`
- Expectation:
  - worker `createWorkerTaskExecutor` runs `agentCommand`
  - model performs `read` tool call against a nonce file
  - result payload includes both expected nonce values
- Result: `PASS`
- Rice usage:
  - none in this isolated worker-quality test (focus is task execution correctness)

### B) Cross-channel delivery routing propagation (`deliver`, `to`, `channel`)

- Aspect tested: routing flags survive the full orchestration request path into worker execution
- Tests:
  - `src/gateway/server-methods/orchestration.test.ts` (gateway handler forwards fields)
  - `src/orchestration/runtime.test.ts` (orchestrator task envelope stores fields)
  - `src/orchestration/worker.test.ts` (worker forwards fields to `agentCommand`)
- Expectations:
  - `orchestration.dispatch` forwards `deliver=true`, `to`, `channel`
  - task variable preserves these fields
  - worker invokes `agentCommand` with matching delivery options
- Result: `PASS`
- Rice usage:
  - fields are serialized in `oc.orch.task.<taskId>` and consumed by worker

## What this report validates

- Multi instance orchestration wiring works end to end across three gateways.
- Routing, dedupe, liveness, failover, recovery, and restart continuity all worked in one full run.
- Rice state is the system of record for orchestration bus data:
  - tasks
  - results
  - heartbeats
  - idempotency map
- Event stream disruptions can still be tolerated because reconciliation polling recovers state.

## Remaining limits

- Real external channel delivery success (for example actual Telegram/Signal send with channel creds) is still environment-dependent and not covered by this Docker flow (`OPENCLAW_SKIP_CHANNELS=1`).
