import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OrchestrationBus, RiceVariableRecord } from "./rice-bus.js";
import { createOrchestrationRuntime, resolveOrchestrationRuntimeConfig } from "./runtime.js";
import {
  ORCH_HEARTBEAT_PREFIX,
  ORCH_IDEMPOTENCY_PREFIX,
  ORCH_RESULT_PREFIX,
  ORCH_TASK_PREFIX,
  type OrchestrationResultEnvelope,
  type OrchestrationTaskEnvelope,
} from "./types.js";

class MockBus implements OrchestrationBus {
  readonly variables = new Map<string, RiceVariableRecord>();
  readonly deleteCalls: string[] = [];
  private listeners = new Set<(evt: { type: string; name?: string; value?: unknown }) => void>();

  async connect(): Promise<void> {}

  async setVariable(name: string, value: unknown): Promise<boolean> {
    const now = new Date().toISOString();
    this.variables.set(name, {
      name,
      value,
      valueJson: JSON.stringify(value),
      createdAt: now,
      lastUpdated: now,
      source: "test",
      raw: {},
    });
    return true;
  }

  async getVariable(name: string): Promise<RiceVariableRecord | null> {
    return this.variables.get(name) ?? null;
  }

  async listVariables(): Promise<RiceVariableRecord[]> {
    return [...this.variables.values()];
  }

  async deleteVariable(name: string): Promise<boolean> {
    this.deleteCalls.push(name);
    return this.variables.delete(name);
  }

  subscribeVariableUpdates(
    listener: (evt: { type: string; name?: string; value?: unknown }) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitVariableUpdate(name: string, value: unknown) {
    this.listeners.forEach((listener) => listener({ type: "VariableUpdate", name, value }));
  }
}

function heartbeat(workerId: string, ts: string): RiceVariableRecord {
  return {
    name: `${ORCH_HEARTBEAT_PREFIX}${workerId}.heartbeat`,
    value: {
      schemaVersion: 1,
      workerId,
      clusterId: "cluster-a",
      ts,
      version: "test",
    },
    valueJson: "{}",
    createdAt: ts,
    lastUpdated: ts,
    source: "test",
    raw: {},
  };
}

function task(params: Partial<OrchestrationTaskEnvelope>): OrchestrationTaskEnvelope {
  const taskId = params.taskId ?? randomUUID();
  return {
    schemaVersion: 1,
    taskId,
    idempotencyKey: params.idempotencyKey ?? `idem-${taskId}`,
    clusterId: params.clusterId ?? "cluster-a",
    sessionKey: params.sessionKey ?? "agent:main:main",
    message: params.message ?? "ping",
    timeoutMs: params.timeoutMs ?? 30_000,
    attempt: params.attempt ?? 1,
    createdAt: params.createdAt ?? new Date().toISOString(),
    createdBy: params.createdBy ?? "test",
    targetWorkerId: params.targetWorkerId,
    agentId: params.agentId,
    thinking: params.thinking,
    deliver: params.deliver,
    to: params.to,
    channel: params.channel,
  };
}

describe("orchestration runtime", () => {
  it("dedupes dispatch by idempotency key", async () => {
    const now = Date.now();
    const bus = new MockBus();
    bus.variables.set(
      `${ORCH_HEARTBEAT_PREFIX}worker-a.heartbeat`,
      heartbeat("worker-a", new Date(now).toISOString()),
    );

    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "orchestrator",
          clusterId: "cluster-a",
          workers: ["worker-a"],
        },
      },
      bus,
      now: () => now,
      executeTask: vi.fn(),
    });
    expect(runtime).not.toBeNull();
    await runtime?.start();

    const first = await runtime?.dispatch({
      idempotencyKey: "same",
      message: "hello",
      sessionKey: "agent:main:main",
    });
    const second = await runtime?.dispatch({
      idempotencyKey: "same",
      message: "hello",
      sessionKey: "agent:main:main",
    });

    expect(first?.status).toBe("accepted");
    expect(second?.status).toBe("deduped");
    expect(second?.taskId).toBe(first?.taskId);

    const taskKeys = [...bus.variables.keys()].filter((name) => name.startsWith(ORCH_TASK_PREFIX));
    const idemKeys = [...bus.variables.keys()].filter((name) =>
      name.startsWith(ORCH_IDEMPOTENCY_PREFIX),
    );
    expect(taskKeys).toHaveLength(1);
    expect(idemKeys).toHaveLength(1);
  });

  it("routes round-robin across live workers", async () => {
    const now = Date.now();
    const bus = new MockBus();
    bus.variables.set(
      `${ORCH_HEARTBEAT_PREFIX}worker-a.heartbeat`,
      heartbeat("worker-a", new Date(now).toISOString()),
    );
    bus.variables.set(
      `${ORCH_HEARTBEAT_PREFIX}worker-b.heartbeat`,
      heartbeat("worker-b", new Date(now).toISOString()),
    );

    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "orchestrator",
          clusterId: "cluster-a",
          workers: ["worker-a", "worker-b"],
        },
      },
      bus,
      now: () => now,
      executeTask: vi.fn(),
    });
    await runtime?.start();

    const first = await runtime?.dispatch({
      idempotencyKey: "k1",
      message: "one",
      sessionKey: "agent:main:main",
    });
    const second = await runtime?.dispatch({
      idempotencyKey: "k2",
      message: "two",
      sessionKey: "agent:main:main",
    });

    expect(first?.targetWorkerId).toBe("worker-a");
    expect(second?.targetWorkerId).toBe("worker-b");
  });

  it("stores delivery routing fields in task envelopes", async () => {
    const now = Date.now();
    const bus = new MockBus();
    bus.variables.set(
      `${ORCH_HEARTBEAT_PREFIX}worker-a.heartbeat`,
      heartbeat("worker-a", new Date(now).toISOString()),
    );

    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "orchestrator",
          clusterId: "cluster-a",
          workers: ["worker-a"],
        },
      },
      bus,
      now: () => now,
      executeTask: vi.fn(),
    });
    await runtime?.start();

    const accepted = await runtime?.dispatch({
      idempotencyKey: "delivery-route-1",
      message: "hello",
      sessionKey: "agent:main:main",
      deliver: true,
      to: "+15550001111",
      channel: "signal",
    });

    const storedTask = bus.variables.get(`${ORCH_TASK_PREFIX}${accepted?.taskId}`)?.value as
      | OrchestrationTaskEnvelope
      | undefined;
    expect(storedTask?.deliver).toBe(true);
    expect(storedTask?.to).toBe("+15550001111");
    expect(storedTask?.channel).toBe("signal");
  });

  it("worker ignores tasks for different worker ids", async () => {
    const bus = new MockBus();
    const executeTask = vi.fn(
      async (input: OrchestrationTaskEnvelope): Promise<OrchestrationResultEnvelope> => ({
        schemaVersion: 1,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        targetWorkerId: "worker-a",
        sessionKey: input.sessionKey,
        status: "ok",
        summary: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempt: input.attempt,
        result: { ok: true },
      }),
    );

    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "worker",
          workerId: "worker-a",
          clusterId: "cluster-a",
        },
      },
      bus,
      executeTask,
    });
    await runtime?.start();

    const t = task({ targetWorkerId: "worker-b" });
    await bus.setVariable(`${ORCH_TASK_PREFIX}${t.taskId}`, t);
    bus.emitVariableUpdate(`${ORCH_TASK_PREFIX}${t.taskId}`, t);

    expect(executeTask).not.toHaveBeenCalled();
    const resultKeys = [...bus.variables.keys()].filter((name) =>
      name.startsWith(ORCH_RESULT_PREFIX),
    );
    expect(resultKeys).toHaveLength(0);
  });

  it("worker dedupes duplicate task deliveries", async () => {
    const bus = new MockBus();
    const executeTask = vi.fn(
      async (input: OrchestrationTaskEnvelope): Promise<OrchestrationResultEnvelope> => ({
        schemaVersion: 1,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        targetWorkerId: "worker-a",
        sessionKey: input.sessionKey,
        status: "ok",
        summary: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempt: input.attempt,
        result: { ok: true },
      }),
    );

    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "worker",
          workerId: "worker-a",
          clusterId: "cluster-a",
        },
      },
      bus,
      executeTask,
    });
    await runtime?.start();

    const t = task({ targetWorkerId: "worker-a" });
    await bus.setVariable(`${ORCH_TASK_PREFIX}${t.taskId}`, t);
    bus.emitVariableUpdate(`${ORCH_TASK_PREFIX}${t.taskId}`, t);
    bus.emitVariableUpdate(`${ORCH_TASK_PREFIX}${t.taskId}`, t);

    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it("emits result fanout metadata for requester + session", async () => {
    const now = Date.now();
    const bus = new MockBus();
    bus.variables.set(
      `${ORCH_HEARTBEAT_PREFIX}worker-a.heartbeat`,
      heartbeat("worker-a", new Date(now).toISOString()),
    );
    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "orchestrator",
          clusterId: "cluster-a",
          workers: ["worker-a"],
        },
      },
      bus,
      now: () => now,
      executeTask: vi.fn(),
    });
    await runtime?.start();

    const eventSpy = vi.fn();
    const unsub = runtime?.onResult(eventSpy);

    const accepted = await runtime?.dispatch(
      {
        idempotencyKey: "fanout-1",
        message: "hello",
        sessionKey: "agent:main:main",
      },
      { requesterConnId: "conn-1" },
    );

    const result: OrchestrationResultEnvelope = {
      schemaVersion: 1,
      taskId: accepted?.taskId ?? "missing",
      idempotencyKey: "fanout-1",
      targetWorkerId: "worker-a",
      sessionKey: "agent:main:main",
      status: "ok",
      summary: "done",
      startedAt: new Date(now).toISOString(),
      finishedAt: new Date(now + 100).toISOString(),
      attempt: 1,
      result: { ok: true },
    };

    await bus.setVariable(`${ORCH_RESULT_PREFIX}${result.taskId}`, result);
    bus.emitVariableUpdate(`${ORCH_RESULT_PREFIX}${result.taskId}`, result);

    expect(eventSpy).toHaveBeenCalledTimes(1);
    const payload = eventSpy.mock.calls[0]?.[0] as {
      result: OrchestrationResultEnvelope;
      requesterConnIds: ReadonlySet<string>;
    };
    expect(payload.result.sessionKey).toBe("agent:main:main");
    expect(payload.requesterConnIds.has("conn-1")).toBe(true);
    unsub?.();
  });

  it("cleans up expired retained keys", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const freshIso = new Date(now).toISOString();
    const bus = new MockBus();
    bus.variables.set(`${ORCH_TASK_PREFIX}old-task`, {
      name: `${ORCH_TASK_PREFIX}old-task`,
      value: task({ taskId: "old-task", createdAt: oldIso }),
      valueJson: "{}",
      createdAt: oldIso,
      lastUpdated: oldIso,
      source: "test",
      raw: {},
    });
    bus.variables.set(`${ORCH_RESULT_PREFIX}old-result`, {
      name: `${ORCH_RESULT_PREFIX}old-result`,
      value: {
        schemaVersion: 1,
        taskId: "old-result",
        idempotencyKey: "old",
        targetWorkerId: "worker-a",
        sessionKey: "agent:main:main",
        status: "ok",
        summary: "old",
        startedAt: oldIso,
        finishedAt: oldIso,
        attempt: 1,
      },
      valueJson: "{}",
      createdAt: oldIso,
      lastUpdated: oldIso,
      source: "test",
      raw: {},
    });
    bus.variables.set(`${ORCH_IDEMPOTENCY_PREFIX}fresh`, {
      name: `${ORCH_IDEMPOTENCY_PREFIX}fresh`,
      value: {
        schemaVersion: 1,
        taskId: "fresh",
        idempotencyKeyHash: "fresh",
        idempotencyKey: "fresh",
        createdAt: freshIso,
      },
      valueJson: "{}",
      createdAt: freshIso,
      lastUpdated: freshIso,
      source: "test",
      raw: {},
    });

    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "orchestrator",
          clusterId: "cluster-a",
          workers: ["worker-a"],
          retention: "1d",
        },
      },
      bus,
      now: () => now,
      executeTask: vi.fn(),
    });

    await runtime?.reconcileOnce();

    expect(bus.deleteCalls).toContain(`${ORCH_TASK_PREFIX}old-task`);
    expect(bus.deleteCalls).toContain(`${ORCH_RESULT_PREFIX}old-result`);
    expect(bus.deleteCalls).not.toContain(`${ORCH_IDEMPOTENCY_PREFIX}fresh`);
  });

  it("cleans up task/result/idempotency after retention window elapses", async () => {
    const startMs = Date.parse("2026-02-01T00:00:00.000Z");
    let nowMs = startMs;
    const bus = new MockBus();
    bus.variables.set(
      `${ORCH_HEARTBEAT_PREFIX}worker-a.heartbeat`,
      heartbeat("worker-a", new Date(startMs).toISOString()),
    );

    const runtime = createOrchestrationRuntime({
      cfg: {
        orchestration: {
          enabled: true,
          role: "orchestrator",
          clusterId: "cluster-a",
          workers: ["worker-a"],
          retention: "2d",
        },
      },
      bus,
      now: () => nowMs,
      executeTask: vi.fn(),
    });
    await runtime?.start();

    const accepted = await runtime?.dispatch({
      idempotencyKey: "retention-horizon",
      message: "hello",
      sessionKey: "agent:main:main",
    });
    expect(accepted?.status).toBe("accepted");
    expect(bus.variables.has(`${ORCH_TASK_PREFIX}${accepted?.taskId}`)).toBe(true);
    expect([...bus.variables.keys()].some((name) => name.startsWith(ORCH_IDEMPOTENCY_PREFIX))).toBe(
      true,
    );

    const result: OrchestrationResultEnvelope = {
      schemaVersion: 1,
      taskId: accepted?.taskId ?? "missing",
      idempotencyKey: "retention-horizon",
      targetWorkerId: "worker-a",
      sessionKey: "agent:main:main",
      status: "ok",
      summary: "done",
      startedAt: new Date(startMs + 1_000).toISOString(),
      finishedAt: new Date(startMs + 2_000).toISOString(),
      attempt: 1,
      result: { ok: true },
    };
    await bus.setVariable(`${ORCH_RESULT_PREFIX}${result.taskId}`, result);

    nowMs = startMs + 24 * 60 * 60 * 1000;
    await runtime?.reconcileOnce();
    expect(bus.deleteCalls).toEqual([]);

    nowMs = startMs + 3 * 24 * 60 * 60 * 1000;
    await runtime?.reconcileOnce();

    expect(bus.deleteCalls).toContain(`${ORCH_TASK_PREFIX}${result.taskId}`);
    expect(bus.deleteCalls).toContain(`${ORCH_RESULT_PREFIX}${result.taskId}`);
    expect(bus.deleteCalls.some((name) => name.startsWith(ORCH_IDEMPOTENCY_PREFIX))).toBe(true);
  });

  it("resolves defaults for orchestration runtime config", () => {
    const resolved = resolveOrchestrationRuntimeConfig({ orchestration: { enabled: true } });
    expect(resolved.enabled).toBe(true);
    expect(resolved.role).toBe("off");
    expect(resolved.clusterId).toBe("local-dev");
    expect(resolved.riceRunId).toBe("openclaw-orchestration");
    expect(resolved.heartbeatIntervalMs).toBe(5_000);
    expect(resolved.heartbeatTtlMs).toBe(20_000);
    expect(resolved.pollIntervalMs).toBe(5_000);
  });
});
