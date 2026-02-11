export type MemoryBackend = "rice";
export type MemoryCitationsMode = "auto" | "on" | "off";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  rice?: MemoryRiceConfig;
};

export type MemoryRiceConfig = {
  enabled?: boolean;
  endpoint?: string;
  runId?: string;
  stateRunId?: string;
  storageRunId?: string;
  sync?: {
    enabled?: boolean;
    interval?: string;
  };
};
