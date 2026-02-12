import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OrchestrationTaskEnvelope } from "./types.js";
import { createWorkerTaskExecutor } from "./worker.js";

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
}));

function makeTask(overrides: Partial<OrchestrationTaskEnvelope> = {}): OrchestrationTaskEnvelope {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    idempotencyKey: "idem-1",
    clusterId: "local-dev",
    targetWorkerId: "worker-a",
    sessionKey: "agent:main:main",
    message: "hello from orchestration worker",
    timeoutMs: 6_500,
    attempt: 2,
    createdAt: new Date("2026-02-12T00:00:00.000Z").toISOString(),
    createdBy: "test",
    ...overrides,
  };
}

describe("createWorkerTaskExecutor", () => {
  beforeEach(() => {
    mocks.agentCommand.mockReset();
  });

  it("forwards deliver/to/channel fields into agentCommand", async () => {
    const deps = {} as CliDeps;
    const task = makeTask({
      deliver: true,
      to: "+15551234567",
      channel: "telegram",
    });
    const agentResult = {
      payloads: [{ text: "ok" }],
      meta: { aborted: false },
    };
    mocks.agentCommand.mockResolvedValue(agentResult);

    const executeTask = createWorkerTaskExecutor({
      workerId: "worker-a",
      deps,
      now: () => Date.parse("2026-02-12T00:00:10.000Z"),
    });

    const result = await executeTask(task);

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: task.message,
        sessionKey: task.sessionKey,
        agentId: undefined,
        thinking: undefined,
        deliver: true,
        to: "+15551234567",
        channel: "telegram",
        timeout: "7",
        runId: "orch:task-1:attempt:2",
      }),
      expect.anything(),
      deps,
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("completed");
    expect(result.targetWorkerId).toBe("worker-a");
    expect(result.result).toEqual(agentResult);
  });

  it("uses default timeout when task timeout is invalid", async () => {
    const deps = {} as CliDeps;
    const task = makeTask({
      timeoutMs: 0,
      attempt: 1,
    });
    mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });

    const executeTask = createWorkerTaskExecutor({
      workerId: "worker-a",
      deps,
      now: () => Date.parse("2026-02-12T00:00:20.000Z"),
    });

    await executeTask(task);

    expect(mocks.agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: "120",
        runId: "orch:task-1:attempt:1",
      }),
      expect.anything(),
      deps,
    );
  });

  it("returns error envelope when agentCommand throws", async () => {
    const deps = {} as CliDeps;
    const task = makeTask({
      deliver: true,
      channel: "signal",
      to: "+15550001111",
    });
    mocks.agentCommand.mockRejectedValue(new Error("delivery failed"));

    const executeTask = createWorkerTaskExecutor({
      workerId: "worker-a",
      deps,
      now: () => Date.parse("2026-02-12T00:00:30.000Z"),
    });

    const result = await executeTask(task);

    expect(result.status).toBe("error");
    expect(result.summary).toContain("delivery failed");
    expect(result.error).toContain("delivery failed");
    expect(result.targetWorkerId).toBe("worker-a");
  });
});
