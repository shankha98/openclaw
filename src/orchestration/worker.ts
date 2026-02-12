import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  DEFAULT_ORCHESTRATION_TASK_TIMEOUT_MS,
  ORCH_SCHEMA_VERSION,
  type OrchestrationResultEnvelope,
  type OrchestrationTaskEnvelope,
} from "./types.js";

export type WorkerTaskExecutor = (
  task: OrchestrationTaskEnvelope,
) => Promise<OrchestrationResultEnvelope>;

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return await promise;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`task timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createWorkerTaskExecutor(params: {
  workerId: string;
  deps: CliDeps;
  runtime?: RuntimeEnv;
  now?: () => number;
}): WorkerTaskExecutor {
  const workerId = params.workerId;
  const deps = params.deps;
  const runtime = params.runtime ?? defaultRuntime;
  const now = params.now ?? Date.now;

  return async (task: OrchestrationTaskEnvelope): Promise<OrchestrationResultEnvelope> => {
    const startedAt = nowIso(now);
    const timeoutMs =
      typeof task.timeoutMs === "number" && Number.isFinite(task.timeoutMs) && task.timeoutMs > 0
        ? Math.floor(task.timeoutMs)
        : DEFAULT_ORCHESTRATION_TASK_TIMEOUT_MS;
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

    try {
      const result = await withTimeout(
        agentCommand(
          {
            message: task.message,
            sessionKey: task.sessionKey,
            agentId: task.agentId,
            thinking: task.thinking,
            deliver: task.deliver === true,
            to: task.to,
            channel: task.channel,
            timeout: String(timeoutSeconds),
            runId: `orch:${task.taskId}:attempt:${task.attempt}`,
          },
          runtime,
          deps,
        ),
        timeoutMs,
      );

      return {
        schemaVersion: ORCH_SCHEMA_VERSION,
        taskId: task.taskId,
        idempotencyKey: task.idempotencyKey,
        targetWorkerId: workerId,
        sessionKey: task.sessionKey,
        status: "ok",
        summary: "completed",
        result,
        startedAt,
        finishedAt: nowIso(now),
        attempt: task.attempt,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        schemaVersion: ORCH_SCHEMA_VERSION,
        taskId: task.taskId,
        idempotencyKey: task.idempotencyKey,
        targetWorkerId: workerId,
        sessionKey: task.sessionKey,
        status: "error",
        summary: error,
        error,
        startedAt,
        finishedAt: nowIso(now),
        attempt: task.attempt,
      };
    }
  };
}
