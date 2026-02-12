import { randomUUID } from "node:crypto";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { createDefaultDeps } from "../cli/deps.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VERSION } from "../version.js";
import { chooseRoundRobinWorker, hashIdempotencyKey } from "./dispatch.js";
import { type OrchestrationBus, RiceOrchestrationBus } from "./rice-bus.js";
import {
  DEFAULT_ORCHESTRATION_CLUSTER_ID,
  DEFAULT_ORCHESTRATION_HEARTBEAT_INTERVAL,
  DEFAULT_ORCHESTRATION_HEARTBEAT_TTL,
  DEFAULT_ORCHESTRATION_POLL_INTERVAL,
  DEFAULT_ORCHESTRATION_RETENTION,
  DEFAULT_ORCHESTRATION_RUN_ID,
  DEFAULT_ORCHESTRATION_TASK_TIMEOUT_MS,
  ORCH_HEARTBEAT_PREFIX,
  ORCH_IDEMPOTENCY_PREFIX,
  ORCH_RESULT_PREFIX,
  ORCH_SCHEMA_VERSION,
  ORCH_TASK_PREFIX,
  heartbeatVariableKey,
  idempotencyVariableKey,
  resultVariableKey,
  taskVariableKey,
  type OrchestrationDispatchOptions,
  type OrchestrationDispatchRequest,
  type OrchestrationDispatchResponse,
  type OrchestrationHeartbeat,
  type OrchestrationIdempotencyRecord,
  type OrchestrationResultEnvelope,
  type OrchestrationResultFanout,
  type OrchestrationRole,
  type OrchestrationRuntime,
  type OrchestrationStatusSnapshot,
  type OrchestrationTaskEnvelope,
  type ResolvedOrchestrationConfig,
} from "./types.js";
import { createWorkerTaskExecutor, type WorkerTaskExecutor } from "./worker.js";

const log = createSubsystemLogger("orchestration");

type RuntimeOptions = {
  cfg: OpenClawConfig;
  deps?: CliDeps;
  bus?: OrchestrationBus;
  executeTask?: WorkerTaskExecutor;
  now?: () => number;
};

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseDurationWithFallback(
  raw: string | undefined,
  fallback: string,
  defaultUnit: "ms" | "s" | "m" | "h" | "d",
): number {
  const input = raw?.trim() || fallback;
  try {
    return parseDurationMs(input, { defaultUnit });
  } catch {
    return parseDurationMs(fallback, { defaultUnit });
  }
}

function normalizeWorkerList(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const workers: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const workerId = entry.trim();
    if (!workerId || seen.has(workerId)) {
      continue;
    }
    seen.add(workerId);
    workers.push(workerId);
  }
  return workers;
}

function parseHeartbeat(value: unknown): OrchestrationHeartbeat | null {
  const obj = toRecord(value);
  if (!obj) {
    return null;
  }
  const workerId = readNonEmptyString(obj.workerId);
  const clusterId = readNonEmptyString(obj.clusterId);
  const ts = readNonEmptyString(obj.ts);
  if (!workerId || !clusterId || !ts) {
    return null;
  }
  const schemaVersion =
    typeof obj.schemaVersion === "number" && Number.isFinite(obj.schemaVersion)
      ? Math.floor(obj.schemaVersion)
      : ORCH_SCHEMA_VERSION;
  const version = readNonEmptyString(obj.version) ?? "unknown";
  return {
    schemaVersion,
    workerId,
    clusterId,
    ts,
    version,
  };
}

function parseTaskEnvelope(value: unknown): OrchestrationTaskEnvelope | null {
  const obj = toRecord(value);
  if (!obj) {
    return null;
  }
  const taskId = readNonEmptyString(obj.taskId);
  const idempotencyKey = readNonEmptyString(obj.idempotencyKey);
  const clusterId = readNonEmptyString(obj.clusterId);
  const sessionKey = readNonEmptyString(obj.sessionKey);
  const message = readNonEmptyString(obj.message);
  const timeoutMs =
    typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs)
      ? Math.max(1, Math.floor(obj.timeoutMs))
      : DEFAULT_ORCHESTRATION_TASK_TIMEOUT_MS;
  const attempt =
    typeof obj.attempt === "number" && Number.isFinite(obj.attempt)
      ? Math.max(1, Math.floor(obj.attempt))
      : 1;
  const createdAt = readNonEmptyString(obj.createdAt);
  const createdBy = readNonEmptyString(obj.createdBy);
  if (
    !taskId ||
    !idempotencyKey ||
    !clusterId ||
    !sessionKey ||
    !message ||
    !createdAt ||
    !createdBy
  ) {
    return null;
  }
  return {
    schemaVersion:
      typeof obj.schemaVersion === "number" && Number.isFinite(obj.schemaVersion)
        ? Math.floor(obj.schemaVersion)
        : ORCH_SCHEMA_VERSION,
    taskId,
    idempotencyKey,
    clusterId,
    targetWorkerId: readNonEmptyString(obj.targetWorkerId),
    sessionKey,
    message,
    agentId: readNonEmptyString(obj.agentId),
    thinking: readNonEmptyString(obj.thinking),
    deliver: obj.deliver === true,
    to: readNonEmptyString(obj.to),
    channel: readNonEmptyString(obj.channel),
    timeoutMs,
    attempt,
    createdAt,
    createdBy,
  };
}

function parseResultEnvelope(value: unknown): OrchestrationResultEnvelope | null {
  const obj = toRecord(value);
  if (!obj) {
    return null;
  }
  const taskId = readNonEmptyString(obj.taskId);
  const idempotencyKey = readNonEmptyString(obj.idempotencyKey);
  const targetWorkerId = readNonEmptyString(obj.targetWorkerId);
  const sessionKey = readNonEmptyString(obj.sessionKey);
  const statusRaw = readNonEmptyString(obj.status);
  const summary = readNonEmptyString(obj.summary);
  const startedAt = readNonEmptyString(obj.startedAt);
  const finishedAt = readNonEmptyString(obj.finishedAt);
  const attempt =
    typeof obj.attempt === "number" && Number.isFinite(obj.attempt)
      ? Math.max(1, Math.floor(obj.attempt))
      : 1;
  const status = statusRaw === "ok" || statusRaw === "error" ? statusRaw : null;
  if (!taskId || !idempotencyKey || !targetWorkerId || !sessionKey || !status || !summary) {
    return null;
  }
  if (!startedAt || !finishedAt) {
    return null;
  }
  return {
    schemaVersion:
      typeof obj.schemaVersion === "number" && Number.isFinite(obj.schemaVersion)
        ? Math.floor(obj.schemaVersion)
        : ORCH_SCHEMA_VERSION,
    taskId,
    idempotencyKey,
    targetWorkerId,
    sessionKey,
    status,
    summary,
    result: obj.result,
    error: readNonEmptyString(obj.error),
    startedAt,
    finishedAt,
    attempt,
  };
}

function parseIdempotencyRecord(value: unknown): OrchestrationIdempotencyRecord | null {
  const obj = toRecord(value);
  if (!obj) {
    return null;
  }
  const taskId = readNonEmptyString(obj.taskId);
  const idempotencyKeyHash = readNonEmptyString(obj.idempotencyKeyHash);
  const idempotencyKey = readNonEmptyString(obj.idempotencyKey);
  const targetWorkerId = readNonEmptyString(obj.targetWorkerId);
  const sessionKey = readNonEmptyString(obj.sessionKey);
  const createdAt = readNonEmptyString(obj.createdAt);
  if (
    !taskId ||
    !idempotencyKeyHash ||
    !idempotencyKey ||
    !targetWorkerId ||
    !sessionKey ||
    !createdAt
  ) {
    return null;
  }
  return {
    schemaVersion:
      typeof obj.schemaVersion === "number" && Number.isFinite(obj.schemaVersion)
        ? Math.floor(obj.schemaVersion)
        : ORCH_SCHEMA_VERSION,
    taskId,
    idempotencyKeyHash,
    idempotencyKey,
    targetWorkerId,
    sessionKey,
    createdAt,
  };
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractRetentionTimestampMs(
  name: string,
  value: unknown,
  fallback?: string,
): number | null {
  if (name.startsWith(ORCH_TASK_PREFIX)) {
    return parseTimestampMs(parseTaskEnvelope(value)?.createdAt) ?? parseTimestampMs(fallback);
  }
  if (name.startsWith(ORCH_RESULT_PREFIX)) {
    const result = parseResultEnvelope(value);
    return parseTimestampMs(result?.finishedAt ?? result?.startedAt) ?? parseTimestampMs(fallback);
  }
  if (name.startsWith(ORCH_IDEMPOTENCY_PREFIX)) {
    return parseTimestampMs(parseIdempotencyRecord(value)?.createdAt) ?? parseTimestampMs(fallback);
  }
  return null;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

export function resolveOrchestrationRuntimeConfig(
  cfg: Pick<OpenClawConfig, "orchestration">,
): ResolvedOrchestrationConfig {
  const orchestration = cfg.orchestration;
  const enabled = orchestration?.enabled === true;
  const role: OrchestrationRole = orchestration?.role ?? "off";
  return {
    enabled,
    role,
    clusterId: orchestration?.clusterId?.trim() || DEFAULT_ORCHESTRATION_CLUSTER_ID,
    workerId: orchestration?.workerId?.trim() || undefined,
    workers: normalizeWorkerList(orchestration?.workers),
    heartbeatIntervalMs: parseDurationWithFallback(
      orchestration?.heartbeat?.interval,
      DEFAULT_ORCHESTRATION_HEARTBEAT_INTERVAL,
      "s",
    ),
    heartbeatTtlMs: parseDurationWithFallback(
      orchestration?.heartbeat?.ttl,
      DEFAULT_ORCHESTRATION_HEARTBEAT_TTL,
      "s",
    ),
    pollIntervalMs: parseDurationWithFallback(
      orchestration?.poll?.interval,
      DEFAULT_ORCHESTRATION_POLL_INTERVAL,
      "s",
    ),
    retentionMs: parseDurationWithFallback(
      orchestration?.retention,
      DEFAULT_ORCHESTRATION_RETENTION,
      "d",
    ),
    riceRunId: orchestration?.rice?.runId?.trim() || DEFAULT_ORCHESTRATION_RUN_ID,
    riceEndpoint: orchestration?.rice?.endpoint?.trim() || undefined,
  };
}

class OrchestrationRuntimeImpl implements OrchestrationRuntime {
  private readonly config: ResolvedOrchestrationConfig;
  private readonly now: () => number;
  private readonly deps: CliDeps;
  private readonly busFactory: () => Promise<OrchestrationBus>;
  private readonly executeTask: WorkerTaskExecutor;

  private bus: OrchestrationBus | null = null;
  private started = false;
  private busUnsub: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly resultListeners = new Set<(payload: OrchestrationResultFanout) => void>();
  private readonly heartbeatByWorker = new Map<string, OrchestrationHeartbeat>();
  private readonly requesterConnIdsByTaskId = new Map<string, Set<string>>();
  private readonly processingTaskIds = new Set<string>();
  private readonly completedTaskAtMs = new Map<string, number>();
  private readonly emittedResultAtMs = new Map<string, number>();
  private roundRobinCursor = 0;

  constructor(params: {
    config: ResolvedOrchestrationConfig;
    deps: CliDeps;
    now: () => number;
    busFactory: () => Promise<OrchestrationBus>;
    executeTask: WorkerTaskExecutor;
  }) {
    this.config = params.config;
    this.deps = params.deps;
    this.now = params.now;
    this.busFactory = params.busFactory;
    this.executeTask = params.executeTask;
  }

  role(): OrchestrationRole {
    return this.config.role;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const bus = await this.ensureBus();
    await bus.connect();

    this.busUnsub = bus.subscribeVariableUpdates((evt) => {
      void this.handleVariableUpdate(evt.name, evt.value).catch((err) => {
        log.warn(`variable update handling failed: ${String(err)}`);
      });
    });

    if (this.config.role === "worker") {
      await this.publishHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        void this.publishHeartbeat().catch((err) => {
          log.warn(`heartbeat publish failed: ${String(err)}`);
        });
      }, this.config.heartbeatIntervalMs);
    }

    this.pollTimer = setInterval(() => {
      void this.reconcileOnce().catch((err) => {
        log.warn(`reconciliation failed: ${String(err)}`);
      });
    }, this.config.pollIntervalMs);

    await this.reconcileOnce();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.busUnsub) {
      this.busUnsub();
      this.busUnsub = null;
    }
  }

  async dispatch(
    input: OrchestrationDispatchRequest,
    opts: OrchestrationDispatchOptions = {},
  ): Promise<OrchestrationDispatchResponse> {
    if (this.config.role !== "orchestrator") {
      throw new Error("orchestration.dispatch requires orchestrator role");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    const message = input.message.trim();
    const sessionKey = input.sessionKey.trim();
    if (!idempotencyKey || !message || !sessionKey) {
      throw new Error("idempotencyKey, message, and sessionKey are required");
    }

    await this.reconcileOnce();
    const nowMs = this.now();
    const bus = await this.ensureBus();
    const idemHash = hashIdempotencyKey(idempotencyKey);
    const idemKey = idempotencyVariableKey(idemHash);

    const existing = await bus.getVariable(idemKey);
    const existingRecord = parseIdempotencyRecord(existing?.value);
    if (existingRecord) {
      this.trackRequester(existingRecord.taskId, opts.requesterConnId);
      return {
        taskId: existingRecord.taskId,
        idempotencyKey,
        targetWorkerId: existingRecord.targetWorkerId,
        status: "deduped",
        acceptedAt: parseTimestampMs(existingRecord.createdAt) ?? nowMs,
      };
    }

    const targetWorkerId = this.selectWorker(input.targetWorkerId, nowMs);
    if (!targetWorkerId) {
      throw new Error("no live workers available");
    }

    const taskId = randomUUID();
    const createdAt = nowIso(this.now);
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : DEFAULT_ORCHESTRATION_TASK_TIMEOUT_MS;
    const taskEnvelope: OrchestrationTaskEnvelope = {
      schemaVersion: ORCH_SCHEMA_VERSION,
      taskId,
      idempotencyKey,
      clusterId: this.config.clusterId,
      targetWorkerId,
      sessionKey,
      message,
      agentId: input.agentId?.trim() || undefined,
      thinking: input.thinking?.trim() || undefined,
      deliver: input.deliver === true,
      to: input.to?.trim() || undefined,
      channel: input.channel?.trim() || undefined,
      timeoutMs,
      attempt: 1,
      createdAt,
      createdBy: opts.createdBy?.trim() || "gateway",
    };
    const idemRecord: OrchestrationIdempotencyRecord = {
      schemaVersion: ORCH_SCHEMA_VERSION,
      taskId,
      idempotencyKeyHash: idemHash,
      idempotencyKey,
      targetWorkerId,
      sessionKey,
      createdAt,
    };

    await bus.setVariable(taskVariableKey(taskId), taskEnvelope, "openclaw.orchestration.dispatch");
    await bus.setVariable(idemKey, idemRecord, "openclaw.orchestration.idempotency");
    this.trackRequester(taskId, opts.requesterConnId);

    return {
      taskId,
      idempotencyKey,
      targetWorkerId,
      status: "accepted",
      acceptedAt: nowMs,
    };
  }

  async status(): Promise<OrchestrationStatusSnapshot> {
    const nowMs = this.now();
    const staticSet = new Set(this.config.workers);
    const workerIds = new Set<string>([...this.heartbeatByWorker.keys(), ...this.config.workers]);
    const workers = [...workerIds]
      .toSorted((a, b) => a.localeCompare(b))
      .map((workerId) => {
        const heartbeat = this.heartbeatByWorker.get(workerId);
        const lastSeenAt = heartbeat?.ts;
        const lastSeenMs = parseTimestampMs(lastSeenAt) ?? 0;
        const ageMs = lastSeenMs > 0 ? Math.max(0, nowMs - lastSeenMs) : undefined;
        const live = typeof ageMs === "number" ? ageMs <= this.config.heartbeatTtlMs : false;
        return {
          workerId,
          live,
          static: staticSet.has(workerId),
          lastSeenAt,
          ageMs,
          version: heartbeat?.version,
        };
      });

    return {
      enabled: this.config.enabled,
      role: this.config.role,
      clusterId: this.config.clusterId,
      runId: this.config.riceRunId,
      workers,
      liveWorkers: workers.filter((worker) => worker.live).map((worker) => worker.workerId),
      ts: nowMs,
    };
  }

  onResult(listener: (payload: OrchestrationResultFanout) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  async reconcileOnce(): Promise<void> {
    const bus = await this.ensureBus();
    const variables = await bus.listVariables();
    for (const variable of variables) {
      if (variable.name.startsWith(ORCH_HEARTBEAT_PREFIX)) {
        const heartbeat = parseHeartbeat(variable.value);
        if (heartbeat && heartbeat.clusterId === this.config.clusterId) {
          this.heartbeatByWorker.set(heartbeat.workerId, heartbeat);
        }
      }
    }

    if (this.config.role === "worker") {
      for (const variable of variables) {
        if (!variable.name.startsWith(ORCH_TASK_PREFIX)) {
          continue;
        }
        await this.handleTaskCandidate(variable.value);
      }
    }

    if (this.config.role === "orchestrator") {
      for (const variable of variables) {
        if (!variable.name.startsWith(ORCH_RESULT_PREFIX)) {
          continue;
        }
        this.handleResultCandidate(variable.value);
      }
    }

    await this.cleanupRetention(variables);
    this.cleanupEphemeralCaches(this.now());
  }

  private async ensureBus(): Promise<OrchestrationBus> {
    if (this.bus) {
      return this.bus;
    }
    this.bus = await this.busFactory();
    return this.bus;
  }

  private selectWorker(targetWorkerIdRaw: string | undefined, nowMs: number): string | null {
    const targetWorkerId = targetWorkerIdRaw?.trim();
    const allowlist = new Set(this.config.workers);

    if (targetWorkerId) {
      if (allowlist.size > 0 && !allowlist.has(targetWorkerId)) {
        throw new Error(
          `target worker is not in orchestration.workers allowlist: ${targetWorkerId}`,
        );
      }
      const heartbeat = this.heartbeatByWorker.get(targetWorkerId);
      if (!heartbeat) {
        throw new Error(`target worker is not live: ${targetWorkerId}`);
      }
      const lastSeenMs = parseTimestampMs(heartbeat.ts) ?? 0;
      const live = lastSeenMs > 0 && nowMs - lastSeenMs <= this.config.heartbeatTtlMs;
      if (!live) {
        throw new Error(`target worker is not live: ${targetWorkerId}`);
      }
      return targetWorkerId;
    }

    const { selectedWorkerId, nextCursor } = chooseRoundRobinWorker({
      workersAllowlist: this.config.workers,
      heartbeatByWorker: this.heartbeatByWorker,
      heartbeatTtlMs: this.config.heartbeatTtlMs,
      cursor: this.roundRobinCursor,
      nowMs,
    });
    this.roundRobinCursor = nextCursor;
    return selectedWorkerId;
  }

  private async publishHeartbeat(): Promise<void> {
    if (this.config.role !== "worker" || !this.config.workerId) {
      return;
    }
    const bus = await this.ensureBus();
    const payload: OrchestrationHeartbeat = {
      schemaVersion: ORCH_SCHEMA_VERSION,
      workerId: this.config.workerId,
      clusterId: this.config.clusterId,
      ts: nowIso(this.now),
      version: VERSION,
    };
    this.heartbeatByWorker.set(payload.workerId, payload);
    await bus.setVariable(
      heartbeatVariableKey(this.config.workerId),
      payload,
      "openclaw.orchestration.heartbeat",
    );
  }

  private async handleVariableUpdate(name: string | undefined, value: unknown): Promise<void> {
    if (!name) {
      return;
    }
    if (name.startsWith(ORCH_HEARTBEAT_PREFIX)) {
      const heartbeat = parseHeartbeat(value);
      if (heartbeat && heartbeat.clusterId === this.config.clusterId) {
        this.heartbeatByWorker.set(heartbeat.workerId, heartbeat);
      }
      return;
    }

    if (this.config.role === "worker" && name.startsWith(ORCH_TASK_PREFIX)) {
      await this.handleTaskCandidate(value);
      return;
    }

    if (this.config.role === "orchestrator" && name.startsWith(ORCH_RESULT_PREFIX)) {
      this.handleResultCandidate(value);
    }
  }

  private async handleTaskCandidate(value: unknown): Promise<void> {
    if (this.config.role !== "worker" || !this.config.workerId) {
      return;
    }
    const task = parseTaskEnvelope(value);
    if (!task) {
      return;
    }
    if (task.clusterId !== this.config.clusterId) {
      return;
    }
    if (task.targetWorkerId && task.targetWorkerId !== this.config.workerId) {
      return;
    }
    if (this.processingTaskIds.has(task.taskId) || this.completedTaskAtMs.has(task.taskId)) {
      return;
    }

    this.processingTaskIds.add(task.taskId);
    try {
      const result = await this.executeTask(task);
      const bus = await this.ensureBus();
      await bus.setVariable(
        resultVariableKey(task.taskId),
        result,
        "openclaw.orchestration.result",
      );
      this.completedTaskAtMs.set(task.taskId, this.now());
    } finally {
      this.processingTaskIds.delete(task.taskId);
    }
  }

  private handleResultCandidate(value: unknown): void {
    const result = parseResultEnvelope(value);
    if (!result) {
      return;
    }
    if (this.emittedResultAtMs.has(result.taskId)) {
      return;
    }
    this.emittedResultAtMs.set(result.taskId, this.now());
    const requesterConnIds = this.requesterConnIdsByTaskId.get(result.taskId) ?? new Set<string>();
    const payload: OrchestrationResultFanout = {
      result,
      requesterConnIds,
    };
    for (const listener of this.resultListeners) {
      try {
        listener(payload);
      } catch {
        // ignore listener errors
      }
    }
    this.requesterConnIdsByTaskId.delete(result.taskId);
  }

  private trackRequester(taskId: string, connId: string | undefined): void {
    const requesterConnId = connId?.trim();
    if (!requesterConnId) {
      return;
    }
    const existing = this.requesterConnIdsByTaskId.get(taskId);
    if (existing) {
      existing.add(requesterConnId);
      return;
    }
    this.requesterConnIdsByTaskId.set(taskId, new Set([requesterConnId]));
  }

  private async cleanupRetention(
    variables: Array<{ name: string; value: unknown; lastUpdated?: string }>,
  ): Promise<void> {
    const nowMs = this.now();
    const deleteKeys: string[] = [];
    for (const variable of variables) {
      if (
        !variable.name.startsWith(ORCH_TASK_PREFIX) &&
        !variable.name.startsWith(ORCH_RESULT_PREFIX) &&
        !variable.name.startsWith(ORCH_IDEMPOTENCY_PREFIX)
      ) {
        continue;
      }
      const ts = extractRetentionTimestampMs(variable.name, variable.value, variable.lastUpdated);
      if (!ts) {
        continue;
      }
      if (nowMs - ts > this.config.retentionMs) {
        deleteKeys.push(variable.name);
      }
    }
    if (deleteKeys.length === 0) {
      return;
    }
    const bus = await this.ensureBus();
    await Promise.all(
      deleteKeys.map(async (key) => {
        try {
          await bus.deleteVariable(key);
        } catch (err) {
          log.warn(`retention cleanup failed for ${key}: ${String(err)}`);
        }
      }),
    );
  }

  private cleanupEphemeralCaches(nowMs: number): void {
    const ephemeralTtl = Math.max(this.config.retentionMs, 60_000);
    for (const [taskId, ts] of this.completedTaskAtMs.entries()) {
      if (nowMs - ts > ephemeralTtl) {
        this.completedTaskAtMs.delete(taskId);
      }
    }
    for (const [taskId, ts] of this.emittedResultAtMs.entries()) {
      if (nowMs - ts > ephemeralTtl) {
        this.emittedResultAtMs.delete(taskId);
      }
    }
  }
}

export function createOrchestrationRuntime(opts: RuntimeOptions): OrchestrationRuntime | null {
  const config = resolveOrchestrationRuntimeConfig(opts.cfg);
  if (!config.enabled || config.role === "off") {
    return null;
  }

  const now = opts.now ?? Date.now;
  const deps = opts.deps ?? createDefaultDeps();
  const busFactory = async (): Promise<OrchestrationBus> => {
    if (opts.bus) {
      return opts.bus;
    }
    return await RiceOrchestrationBus.create({
      runId: config.riceRunId,
      endpoint: config.riceEndpoint,
    });
  };

  let executeTask = opts.executeTask;
  if (!executeTask) {
    if (config.role === "worker" && config.workerId) {
      executeTask = createWorkerTaskExecutor({
        workerId: config.workerId,
        deps,
        now,
      });
    } else {
      executeTask = async (task) => ({
        schemaVersion: ORCH_SCHEMA_VERSION,
        taskId: task.taskId,
        idempotencyKey: task.idempotencyKey,
        targetWorkerId: task.targetWorkerId ?? "",
        sessionKey: task.sessionKey,
        status: "error",
        summary: "worker execution unavailable",
        error: "worker execution unavailable",
        startedAt: nowIso(now),
        finishedAt: nowIso(now),
        attempt: task.attempt,
      });
    }
  }

  return new OrchestrationRuntimeImpl({
    config,
    deps,
    now,
    busFactory,
    executeTask,
  });
}
