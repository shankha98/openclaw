import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { orchestrationHandlers } from "./orchestration.js";

const makeContext = (overrides?: Partial<GatewayRequestContext>): GatewayRequestContext =>
  ({
    orchestration: null,
    ...overrides,
  }) as unknown as GatewayRequestContext;

describe("gateway orchestration handlers", () => {
  it("rejects dispatch when runtime is not orchestrator", async () => {
    const respond = vi.fn();
    await orchestrationHandlers["orchestration.dispatch"]({
      req: { type: "req", id: "1", method: "orchestration.dispatch" },
      params: {
        idempotencyKey: "idem-1",
        message: "hello",
        sessionKey: "agent:main:main",
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: makeContext(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/orchestrator/i) }),
    );
  });

  it("passes requester connId into runtime dispatch", async () => {
    const dispatch = vi.fn(async () => ({
      taskId: "task-1",
      idempotencyKey: "idem-1",
      targetWorkerId: "worker-a",
      status: "accepted",
      acceptedAt: Date.now(),
    }));
    const status = vi.fn(async () => ({
      enabled: true,
      role: "orchestrator",
      clusterId: "local-dev",
      runId: "openclaw-orchestration",
      workers: [],
      liveWorkers: [],
      ts: Date.now(),
    }));

    const context = makeContext({
      orchestration: {
        role: () => "orchestrator",
        dispatch,
        status,
        onResult: () => () => {},
        start: async () => {},
        stop: async () => {},
        reconcileOnce: async () => {},
      },
    });

    const respond = vi.fn();
    await orchestrationHandlers["orchestration.dispatch"]({
      req: { type: "req", id: "1", method: "orchestration.dispatch" },
      params: {
        idempotencyKey: "idem-1",
        message: "hello",
        sessionKey: "agent:main:main",
      },
      client: {
        connId: "conn-1",
        connect: {
          minProtocol: 1,
          maxProtocol: 99,
          client: {
            id: "test",
            version: "dev",
            platform: process.platform,
            mode: "test",
          },
        },
      },
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "idem-1" }),
      expect.objectContaining({ requesterConnId: "conn-1" }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ taskId: "task-1", status: "accepted" }),
      undefined,
    );
  });

  it("returns runtime status", async () => {
    const statusPayload = {
      enabled: true,
      role: "worker" as const,
      clusterId: "local-dev",
      runId: "openclaw-orchestration",
      workers: [{ workerId: "worker-a", live: true, static: true }],
      liveWorkers: ["worker-a"],
      ts: Date.now(),
    };
    const context = makeContext({
      orchestration: {
        role: () => "worker",
        dispatch: vi.fn(),
        status: vi.fn(async () => statusPayload),
        onResult: () => () => {},
        start: async () => {},
        stop: async () => {},
        reconcileOnce: async () => {},
      },
    });

    const respond = vi.fn();
    await orchestrationHandlers["orchestration.status"]({
      req: { type: "req", id: "1", method: "orchestration.status" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(true, statusPayload, undefined);
  });
});
