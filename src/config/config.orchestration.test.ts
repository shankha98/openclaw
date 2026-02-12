import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("orchestration config", () => {
  it("accepts orchestrator config", () => {
    const res = validateConfigObject({
      orchestration: {
        enabled: true,
        role: "orchestrator",
        workers: ["worker-a", "worker-b"],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts worker config with workerId", () => {
    const res = validateConfigObject({
      orchestration: {
        enabled: true,
        role: "worker",
        workerId: "worker-a",
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects worker config when workerId is missing", () => {
    const res = validateConfigObject({
      orchestration: {
        enabled: true,
        role: "worker",
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "orchestration.workerId",
            message: expect.stringMatching(/required when orchestration\.role=worker/i),
          }),
        ]),
      );
    }
  });

  it("rejects invalid duration strings", () => {
    const res = validateConfigObject({
      orchestration: {
        enabled: true,
        role: "orchestrator",
        heartbeat: { interval: "soon" },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "orchestration.heartbeat.interval",
            message: expect.stringMatching(/invalid duration/i),
          }),
        ]),
      );
    }
  });
});
