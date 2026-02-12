export type OrchestrationRole = "off" | "orchestrator" | "worker";

export type OrchestrationRiceConfig = {
  /** Shared Rice run ID used by all orchestration participants. */
  runId?: string;
  /**
   * Optional shared endpoint for orchestration state operations.
   * When set, OpenClaw points both STATE_INSTANCE_URL and STORAGE_INSTANCE_URL here.
   */
  endpoint?: string;
};

export type OrchestrationHeartbeatConfig = {
  /** Heartbeat publish interval (duration string, default: 5s). */
  interval?: string;
  /** Heartbeat staleness threshold (duration string, default: 20s). */
  ttl?: string;
};

export type OrchestrationPollConfig = {
  /** Reconciliation polling interval for missed events (duration string, default: 5s). */
  interval?: string;
};

export type OrchestrationConfig = {
  /** Enables orchestration runtime wiring inside the gateway. */
  enabled?: boolean;
  /** Runtime role for this instance. */
  role?: OrchestrationRole;
  /** Cluster identifier used to avoid cross-environment event collisions. */
  clusterId?: string;
  /** Worker identity (required when role=worker). */
  workerId?: string;
  /** Static worker allowlist used by orchestrators. */
  workers?: string[];
  heartbeat?: OrchestrationHeartbeatConfig;
  poll?: OrchestrationPollConfig;
  /** Variable retention window (duration string, default: 7d). */
  retention?: string;
  rice?: OrchestrationRiceConfig;
};
