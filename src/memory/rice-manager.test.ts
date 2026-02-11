import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { RiceMemoryManager } from "./rice-manager.js";

const riceMocks = vi.hoisted(() => {
  const storageSearch = vi.fn();
  const storageHealth = vi.fn(async () => ({ status: "ok" }));
  const stateReminisce = vi.fn();
  const stateDrift = vi.fn(async () => []);
  const stateCommit = vi.fn(async () => true);
  const connect = vi.fn(async () => {});
  const Client = vi.fn(function MockRiceClient(this: Record<string, unknown>) {
    this.connect = connect;
    this.storage = {
      search: storageSearch,
      health: storageHealth,
    };
    this.state = {
      reminisce: stateReminisce,
      drift: stateDrift,
      commit: stateCommit,
    };
  });
  return {
    storageSearch,
    storageHealth,
    stateReminisce,
    stateDrift,
    stateCommit,
    connect,
    Client,
  };
});

vi.mock("rice-node-sdk", () => ({
  Client: riceMocks.Client,
}));

function buildConfig(): OpenClawConfig {
  return {
    memory: {
      rice: {
        enabled: true,
        sync: {
          enabled: false,
        },
      },
    },
    agents: {
      defaults: {
        workspace: "/tmp/openclaw-workspace",
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/openclaw-workspace",
          default: true,
        },
      ],
    },
  };
}

describe("RiceMemoryManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env.STORAGE_INSTANCE_URL;
    delete process.env.STATE_INSTANCE_URL;
  });

  it("searches storage + state and serves memory_get reads from cached results", async () => {
    riceMocks.storageSearch.mockResolvedValueOnce([
      {
        id: "42",
        similarity: 0.92,
        data: "Storage memory line",
        metadata: {
          path: "MEMORY.md",
          startLine: 3,
          endLine: 3,
        },
      },
    ]);
    riceMocks.stateReminisce.mockResolvedValueOnce([
      {
        input: "User prefers metric units",
        outcome: "Preference saved",
        action: "remember",
        reasoning: "long-term preference",
        agent_id: "main",
      },
    ]);

    const manager = await RiceMemoryManager.create({
      cfg: buildConfig(),
      agentId: "main",
    });
    expect(riceMocks.Client).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: expect.any(String),
        runId: "main",
      }),
    );

    const results = await manager.search("metric preferences", { maxResults: 5 });
    expect(results.length).toBe(2);
    expect(results[0]?.path).toBe("rice:storage/42");
    const stateResult = results.find((entry) => entry.path.startsWith("rice:state/"));
    expect(stateResult).toBeDefined();

    await expect(manager.readFile({ relPath: "rice:storage/42" })).resolves.toEqual({
      path: "rice:storage/42",
      text: "Storage memory line",
    });

    if (!stateResult) {
      throw new Error("missing state result");
    }
    const stateText = await manager.readFile({ relPath: stateResult.path, from: 1, lines: 2 });
    expect(stateText.text).toContain("Input:");
    expect(stateText.text).toContain("Outcome:");

    await manager.close();
  });

  it("rejects reads for paths that were not returned by memory_search", async () => {
    riceMocks.storageSearch.mockResolvedValueOnce([]);
    riceMocks.stateReminisce.mockResolvedValueOnce([]);

    const manager = await RiceMemoryManager.create({
      cfg: buildConfig(),
      agentId: "main",
    });

    await manager.search("nothing");
    await expect(manager.readFile({ relPath: "MEMORY.md" })).rejects.toThrow(
      "path required: use a path returned by memory_search",
    );

    await manager.close();
  });

  it("reports vector + embeddings availability and exposes remote sync progress", async () => {
    riceMocks.storageSearch.mockResolvedValueOnce([]);
    riceMocks.stateReminisce.mockResolvedValueOnce([]);

    const manager = await RiceMemoryManager.create({
      cfg: buildConfig(),
      agentId: "main",
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });

    const progress = vi.fn();
    await manager.sync({ progress });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        completed: 1,
        total: 1,
      }),
    );

    const status = manager.status();
    expect(status.backend).toBe("rice");
    expect(status.provider).toBe("rice-node-sdk");
    expect(status.model).toBe("state+storage");

    await manager.close();
  });

  it("stores durable memory through Rice state commit", async () => {
    riceMocks.storageSearch.mockResolvedValueOnce([]);
    riceMocks.stateReminisce.mockResolvedValueOnce([]);

    const manager = await RiceMemoryManager.create({
      cfg: buildConfig(),
      agentId: "main",
    });

    const result = await manager.store({
      input: "User prefers concise answers",
      outcome: "Preference persisted",
      action: "remember_preference",
      reasoning: "durable profile setting",
    });

    expect(riceMocks.stateCommit).toHaveBeenCalledWith(
      "User prefers concise answers",
      "Preference persisted",
      {
        action: "remember_preference",
        reasoning: "durable profile setting",
        agent_id: "main",
      },
    );
    expect(result).toEqual({
      ok: true,
      provider: "rice-node-sdk",
    });

    await manager.close();
  });

  it("passes split state/storage run IDs to unified Rice client", async () => {
    riceMocks.storageSearch.mockResolvedValueOnce([]);
    riceMocks.stateReminisce.mockResolvedValueOnce([]);

    const cfg = buildConfig();
    if (!cfg.memory?.rice) {
      throw new Error("missing rice config");
    }
    Object.assign(cfg.memory.rice, {
      runId: "shared-run",
      stateRunId: "state-run-only",
      storageRunId: "storage-run-only",
    });

    const manager = await RiceMemoryManager.create({
      cfg,
      agentId: "main",
    });

    expect(riceMocks.Client).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: expect.any(String),
        runId: "shared-run",
        stateRunId: "state-run-only",
        storageRunId: "storage-run-only",
      }),
    );

    await manager.close();
  });
});
