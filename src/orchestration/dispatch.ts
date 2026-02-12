import crypto from "node:crypto";
import type { OrchestrationHeartbeat } from "./types.js";

export type WorkerLivenessSnapshot = {
  workerId: string;
  heartbeat: OrchestrationHeartbeat;
  lastSeenMs: number;
  live: boolean;
};

export function hashIdempotencyKey(idempotencyKey: string): string {
  return crypto.createHash("sha256").update(idempotencyKey).digest("hex");
}

export function resolveLiveWorkers(params: {
  workersAllowlist: string[];
  heartbeatByWorker: ReadonlyMap<string, OrchestrationHeartbeat>;
  heartbeatTtlMs: number;
  nowMs: number;
}): WorkerLivenessSnapshot[] {
  const allowlist = new Set(params.workersAllowlist);
  const workers = new Set<string>();
  if (allowlist.size > 0) {
    for (const workerId of allowlist) {
      workers.add(workerId);
    }
  } else {
    for (const workerId of params.heartbeatByWorker.keys()) {
      workers.add(workerId);
    }
  }

  const snapshots: WorkerLivenessSnapshot[] = [];
  for (const workerId of workers) {
    const heartbeat = params.heartbeatByWorker.get(workerId);
    if (!heartbeat) {
      snapshots.push({
        workerId,
        heartbeat: {
          schemaVersion: 1,
          workerId,
          clusterId: "",
          ts: "",
          version: "",
        },
        lastSeenMs: 0,
        live: false,
      });
      continue;
    }
    const tsMs = Date.parse(heartbeat.ts);
    const lastSeenMs = Number.isFinite(tsMs) ? tsMs : 0;
    const ageMs = params.nowMs - lastSeenMs;
    snapshots.push({
      workerId,
      heartbeat,
      lastSeenMs,
      live: lastSeenMs > 0 && ageMs <= params.heartbeatTtlMs,
    });
  }

  snapshots.sort((a, b) => a.workerId.localeCompare(b.workerId));
  return snapshots;
}

export function chooseRoundRobinWorker(params: {
  workersAllowlist: string[];
  heartbeatByWorker: ReadonlyMap<string, OrchestrationHeartbeat>;
  heartbeatTtlMs: number;
  cursor: number;
  nowMs: number;
}): {
  selectedWorkerId: string | null;
  nextCursor: number;
  liveWorkers: string[];
} {
  const liveness = resolveLiveWorkers({
    workersAllowlist: params.workersAllowlist,
    heartbeatByWorker: params.heartbeatByWorker,
    heartbeatTtlMs: params.heartbeatTtlMs,
    nowMs: params.nowMs,
  });
  const liveWorkers = liveness.filter((entry) => entry.live).map((entry) => entry.workerId);
  if (liveWorkers.length === 0) {
    return {
      selectedWorkerId: null,
      nextCursor: params.cursor,
      liveWorkers,
    };
  }
  const index = ((params.cursor % liveWorkers.length) + liveWorkers.length) % liveWorkers.length;
  const selectedWorkerId = liveWorkers[index] ?? null;
  return {
    selectedWorkerId,
    nextCursor: (index + 1) % liveWorkers.length,
    liveWorkers,
  };
}
