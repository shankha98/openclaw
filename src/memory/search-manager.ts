import type { OpenClawConfig } from "../config/config.js";
import type { MemorySearchManager } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

const log = createSubsystemLogger("memory");
const RICE_MANAGER_CACHE = new Map<string, MemorySearchManager>();

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(params);

  // Always use Rice backend
  const cacheKey = `rice:${params.agentId}`;
  const cached = RICE_MANAGER_CACHE.get(cacheKey);
  if (cached) {
    return { manager: cached };
  }

  if (!resolved.rice) {
    return { manager: null, error: "Rice configuration missing" };
  }

  try {
    const { RiceMemoryManager } = await import("./rice-manager.js");
    const manager = await RiceMemoryManager.create({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    RICE_MANAGER_CACHE.set(cacheKey, manager);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`rice memory initialization failed: ${message}`);
    return { manager: null, error: message };
  }
}
