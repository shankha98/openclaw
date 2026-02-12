import type { OrchestrationRole } from "../config/types.orchestration.js";
export type { OrchestrationRole } from "../config/types.orchestration.js";

export const ORCH_SCHEMA_VERSION = 1 as const;

export const ORCH_TASK_PREFIX = "oc.orch.task.";
export const ORCH_RESULT_PREFIX = "oc.orch.result.";
export const ORCH_HEARTBEAT_PREFIX = "oc.orch.worker.";
export const ORCH_IDEMPOTENCY_PREFIX = "oc.orch.idem.";

export const DEFAULT_ORCHESTRATION_CLUSTER_ID = "local-dev";
export const DEFAULT_ORCHESTRATION_HEARTBEAT_INTERVAL = "5s";
export const DEFAULT_ORCHESTRATION_HEARTBEAT_TTL = "20s";
export const DEFAULT_ORCHESTRATION_POLL_INTERVAL = "5s";
export const DEFAULT_ORCHESTRATION_RETENTION = "7d";
export const DEFAULT_ORCHESTRATION_RUN_ID = "openclaw-orchestration";
export const DEFAULT_ORCHESTRATION_TASK_TIMEOUT_MS = 120_000;

export function taskVariableKey(taskId: string): string {
  return `${ORCH_TASK_PREFIX}${taskId}`;
}

export function resultVariableKey(taskId: string): string {
  return `${ORCH_RESULT_PREFIX}${taskId}`;
}

export function heartbeatVariableKey(workerId: string): string {
  return `${ORCH_HEARTBEAT_PREFIX}${workerId}.heartbeat`;
}

export function idempotencyVariableKey(idempotencyHash: string): string {
  return `${ORCH_IDEMPOTENCY_PREFIX}${idempotencyHash}`;
}

export type OrchestrationTaskEnvelope = {
  schemaVersion: number;
  taskId: string;
  idempotencyKey: string;
  clusterId: string;
  targetWorkerId?: string;
  sessionKey: string;
  message: string;
  agentId?: string;
  thinking?: string;
  deliver?: boolean;
  to?: string;
  channel?: string;
  timeoutMs: number;
  attempt: number;
  createdAt: string;
  createdBy: string;
};

export type OrchestrationResultEnvelope = {
  schemaVersion: number;
  taskId: string;
  idempotencyKey: string;
  targetWorkerId: string;
  sessionKey: string;
  status: "ok" | "error";
  summary: string;
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt: string;
  attempt: number;
};

export type OrchestrationHeartbeat = {
  schemaVersion: number;
  workerId: string;
  clusterId: string;
  ts: string;
  version: string;
};

export type OrchestrationIdempotencyRecord = {
  schemaVersion: number;
  taskId: string;
  idempotencyKeyHash: string;
  idempotencyKey: string;
  targetWorkerId: string;
  sessionKey: string;
  createdAt: string;
};

export type OrchestrationDispatchRequest = {
  idempotencyKey: string;
  message: string;
  sessionKey: string;
  targetWorkerId?: string;
  agentId?: string;
  thinking?: string;
  deliver?: boolean;
  to?: string;
  channel?: string;
  timeoutMs?: number;
};

export type OrchestrationDispatchResponse = {
  taskId: string;
  idempotencyKey: string;
  targetWorkerId: string;
  status: "accepted" | "deduped";
  acceptedAt: number;
};

export type OrchestrationDispatchOptions = {
  requesterConnId?: string;
  createdBy?: string;
};

export type OrchestrationWorkerStatus = {
  workerId: string;
  live: boolean;
  static: boolean;
  lastSeenAt?: string;
  ageMs?: number;
  version?: string;
};

export type OrchestrationStatusSnapshot = {
  enabled: boolean;
  role: OrchestrationRole;
  clusterId: string | null;
  runId: string | null;
  workers: OrchestrationWorkerStatus[];
  liveWorkers: string[];
  ts: number;
};

export type OrchestrationResultFanout = {
  result: OrchestrationResultEnvelope;
  requesterConnIds: ReadonlySet<string>;
};

export type ResolvedOrchestrationConfig = {
  enabled: boolean;
  role: OrchestrationRole;
  clusterId: string;
  workerId?: string;
  workers: string[];
  heartbeatIntervalMs: number;
  heartbeatTtlMs: number;
  pollIntervalMs: number;
  retentionMs: number;
  riceRunId: string;
  riceEndpoint?: string;
};

export type OrchestrationRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  role: () => OrchestrationRole;
  dispatch: (
    input: OrchestrationDispatchRequest,
    opts?: OrchestrationDispatchOptions,
  ) => Promise<OrchestrationDispatchResponse>;
  status: () => Promise<OrchestrationStatusSnapshot>;
  onResult: (listener: (payload: OrchestrationResultFanout) => void) => () => void;
  reconcileOnce: () => Promise<void>;
};
