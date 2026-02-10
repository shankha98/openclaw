import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.fn(async () => ({ ok: true, provider: "rice-node-sdk" }));

vi.mock("../../memory/index.js", () => {
  return {
    getMemorySearchManager: async () => ({
      manager: {
        store: storeMock,
      },
    }),
  };
});

import { createMemoryStoreTool } from "./memory-tool.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memory_store tool", () => {
  it("stores durable memory via manager.store", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemoryStoreTool({ config: cfg, agentSessionKey: "agent:main:main" });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_store", {
      content: "User prefers metric units.",
      summary: "Preference recorded",
      action: "remember_preference",
      reasoning: "durable user preference",
    });

    expect(storeMock).toHaveBeenCalledWith({
      input: "User prefers metric units.",
      outcome: "Preference recorded",
      action: "remember_preference",
      reasoning: "durable user preference",
      sessionKey: "agent:main:main",
    });
    expect(result.details).toEqual({
      ok: true,
      provider: "rice-node-sdk",
    });
  });

  it("returns disabled result when manager.store throws", async () => {
    storeMock.mockRejectedValueOnce(new Error("state unavailable"));
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemoryStoreTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_store_fail", {
      content: "Store this",
    });

    expect(result.details).toEqual({
      ok: false,
      disabled: true,
      error: "state unavailable",
    });
  });
});
