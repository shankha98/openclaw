import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryRiceConfig,
} from "../config/types.memory.js";
import { parseDurationMs } from "../cli/parse-duration.js";

export type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
  rice?: ResolvedRiceConfig;
};

export type ResolvedRiceConfig = {
  enabled: boolean;
  endpoint?: string;
  runId?: string;
  sync: {
    enabled: boolean;
    intervalMs: number;
  };
};

const DEFAULT_BACKEND: MemoryBackend = "rice";
const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";
const DEFAULT_RICE_SYNC_INTERVAL = "1m";

function resolveIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_RICE_SYNC_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_RICE_SYNC_INTERVAL, { defaultUnit: "m" });
  }
}

export function resolveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const backend: MemoryBackend = "rice";
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;

  const rice = params.cfg.memory?.rice;
  return {
    backend,
    citations,
    rice: {
      enabled: rice?.enabled !== false,
      endpoint: rice?.endpoint,
      runId: rice?.runId,
      sync: {
        enabled: rice?.sync?.enabled !== false,
        intervalMs: resolveIntervalMs(rice?.sync?.interval || DEFAULT_RICE_SYNC_INTERVAL),
      },
    },
  };
}
