import { createHash } from "node:crypto";
import { Client } from "rice-node-sdk";
import { type RawData, WebSocket } from "ws";
import { parseDurationMs } from "../../src/cli/parse-duration.ts";
import { PROTOCOL_VERSION } from "../../src/gateway/protocol/index.ts";
import { ensureRiceSdkConfigPath } from "../../src/memory/rice-sdk-config.ts";

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

type OrchestrationDispatchResult = {
  taskId: string;
  idempotencyKey: string;
  targetWorkerId: string;
  status: "accepted" | "deduped";
  acceptedAt: number;
};

type OrchestrationStatusResult = {
  enabled: boolean;
  role: "off" | "orchestrator" | "worker";
  clusterId: string | null;
  runId: string | null;
  workers: Array<{
    workerId: string;
    live: boolean;
    static: boolean;
    lastSeenAt?: string;
    ageMs?: number;
    version?: string;
  }>;
  liveWorkers: string[];
  ts: number;
};

type OrchestrationResultEvent = {
  taskId: string;
  idempotencyKey: string;
  targetWorkerId: string;
  sessionKey: string;
  status: "ok" | "error";
  summary: string;
  startedAt: string;
  finishedAt: string;
  attempt: number;
  result?: unknown;
  error?: string;
};

type EventWaiter = {
  event: string;
  predicate: (payload: unknown, frame: Record<string, unknown>) => boolean;
  resolve: (payload: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const phase = (process.env.ORCH_EXT_PHASE ?? "baseline").trim();
const gatewayUrl = process.env.ORCH_GATEWAY_URL?.trim();
const gatewayToken = process.env.ORCH_GATEWAY_TOKEN?.trim();
const runId = process.env.ORCH_RUN_ID?.trim();
const burstCount = parsePositiveInt(process.env.ORCH_BURST_COUNT, 24);
const riceEndpoint = process.env.ORCH_RICE_ENDPOINT?.trim();
const stateInstanceUrl = process.env.ORCH_STATE_INSTANCE_URL?.trim();
const stateAuthToken = process.env.ORCH_STATE_AUTH_TOKEN?.trim();
const storageInstanceUrl = process.env.ORCH_STORAGE_INSTANCE_URL?.trim();
const storageAuthToken = process.env.ORCH_STORAGE_AUTH_TOKEN?.trim();
const storageHttpPort = process.env.ORCH_STORAGE_HTTP_PORT?.trim();
const retentionRaw = (process.env.ORCH_RETENTION ?? "7d").trim();

if (!gatewayUrl || !gatewayToken || !runId) {
  throw new Error("missing ORCH_GATEWAY_URL/ORCH_GATEWAY_TOKEN/ORCH_RUN_ID");
}
if (!riceEndpoint && (!stateInstanceUrl || !storageInstanceUrl)) {
  throw new Error(
    "missing Rice connection info: set ORCH_RICE_ENDPOINT or ORCH_STATE_INSTANCE_URL + ORCH_STORAGE_INSTANCE_URL",
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function frameErrorMessage(frame: GatewayResponseFrame): string {
  return frame.error?.message ?? frame.error?.code ?? "unknown error";
}

function randomKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hashIdempotencyKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function parseRetentionMsOrThrow(raw: string): number {
  try {
    return parseDurationMs(raw, { defaultUnit: "d" });
  } catch (err) {
    throw new Error(`invalid ORCH_RETENTION duration "${raw}": ${String(err)}`, { cause: err });
  }
}

async function openWebSocket(url: string, timeoutMs = 8_000): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.on("error", () => {
    // Prevent process crash for transient socket reset errors.
  });
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(new Error("websocket open timeout"));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

class GatewayClient {
  private readonly ws: WebSocket;
  private readonly pendingResponses = new Map<
    string,
    {
      resolve: (frame: GatewayResponseFrame) => void;
      reject: (err: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly eventWaiters = new Set<EventWaiter>();
  private readonly eventBacklog = new Map<
    string,
    Array<{ payload: unknown; frame: Record<string, unknown> }>
  >();
  private seq = 0;
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.onClose());
  }

  static async connect(params: {
    url: string;
    token: string;
    label: string;
    attempts?: number;
    delayMs?: number;
  }): Promise<GatewayClient> {
    const attempts = params.attempts ?? 20;
    const delayMs = params.delayMs ?? 500;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let client: GatewayClient | null = null;
      try {
        const ws = await openWebSocket(params.url);
        client = new GatewayClient(ws);
        await client.waitEvent("connect.challenge", () => true, 1_000).catch(() => undefined);
        const connect = await client.rpc(
          "connect",
          {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "test",
              displayName: `orchestration-extended-${params.label}`,
              version: "dev",
              platform: process.platform,
              mode: "test",
            },
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.admin"],
            caps: [],
            auth: { token: params.token },
          },
          25_000,
        );
        if (!connect.ok) {
          throw new Error(`connect failed: ${frameErrorMessage(connect)}`);
        }
        if (attempt > 1) {
          console.log(`[extended] ${params.label} connected on retry attempt ${attempt}`);
        } else {
          console.log(`[extended] ${params.label} connected`);
        }
        return client;
      } catch (err) {
        lastError = err;
        if (client) {
          await client.close();
        }
        if (attempt === attempts) {
          break;
        }
        await sleep(delayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async rpc(
    method: string,
    params: unknown = {},
    timeoutMs = 20_000,
  ): Promise<GatewayResponseFrame> {
    if (this.closed) {
      throw new Error("websocket closed");
    }
    const id = `r${++this.seq}`;
    const frame = {
      type: "req",
      id,
      method,
      params,
    };
    const response = await new Promise<GatewayResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`rpc timeout for ${method}`));
      }, timeoutMs);
      this.pendingResponses.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(frame), (err) => {
        if (!err) {
          return;
        }
        clearTimeout(timer);
        this.pendingResponses.delete(id);
        reject(err);
      });
    });
    return response;
  }

  async waitEvent<TPayload>(
    event: string,
    predicate: (payload: unknown, frame: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<TPayload> {
    if (this.closed) {
      throw new Error("websocket closed");
    }
    const backlog = this.eventBacklog.get(event);
    if (backlog && backlog.length > 0) {
      for (let idx = 0; idx < backlog.length; idx += 1) {
        const entry = backlog[idx];
        let matches = false;
        try {
          matches = predicate(entry.payload, entry.frame);
        } catch {
          matches = false;
        }
        if (!matches) {
          continue;
        }
        backlog.splice(idx, 1);
        return entry.payload as TPayload;
      }
    }
    return await new Promise<TPayload>((resolve, reject) => {
      const waiter: EventWaiter = {
        event,
        predicate,
        resolve: (payload) => {
          this.eventWaiters.delete(waiter);
          resolve(payload as TPayload);
        },
        reject: (err) => {
          this.eventWaiters.delete(waiter);
          reject(err);
        },
        timer: setTimeout(() => {
          this.eventWaiters.delete(waiter);
          reject(new Error(`event timeout for ${event}`));
        }, timeoutMs),
      };
      this.eventWaiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("websocket closed"));
    }
    this.pendingResponses.clear();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("websocket closed"));
    }
    this.eventWaiters.clear();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.ws.close();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private onMessage(data: RawData): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (frame.type === "res" && typeof frame.id === "string") {
      const pending = this.pendingResponses.get(frame.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingResponses.delete(frame.id);
      pending.resolve(frame as GatewayResponseFrame);
      return;
    }

    if (frame.type !== "event" || typeof frame.event !== "string") {
      return;
    }
    const payload = frame.payload;
    for (const waiter of [...this.eventWaiters]) {
      if (waiter.event !== frame.event) {
        continue;
      }
      try {
        if (!waiter.predicate(payload, frame)) {
          continue;
        }
      } catch {
        continue;
      }
      clearTimeout(waiter.timer);
      this.eventWaiters.delete(waiter);
      waiter.resolve(payload);
      return;
    }
    const backlog = this.eventBacklog.get(frame.event) ?? [];
    backlog.push({ payload, frame });
    this.eventBacklog.set(frame.event, backlog);
  }

  private onClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("websocket closed"));
    }
    this.pendingResponses.clear();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("websocket closed"));
    }
    this.eventWaiters.clear();
  }
}

async function orchestrationStatus(client: GatewayClient): Promise<OrchestrationStatusResult> {
  const res = await client.rpc("orchestration.status", {}, 20_000);
  if (!res.ok) {
    throw new Error(`orchestration.status failed: ${frameErrorMessage(res)}`);
  }
  return res.payload as OrchestrationStatusResult;
}

async function waitForStatus(
  client: GatewayClient,
  predicate: (status: OrchestrationStatusResult) => boolean,
  timeoutMs: number,
  label: string,
): Promise<OrchestrationStatusResult> {
  const deadline = Date.now() + timeoutMs;
  let latest: OrchestrationStatusResult | null = null;
  while (Date.now() < deadline) {
    latest = await orchestrationStatus(client);
    if (predicate(latest)) {
      return latest;
    }
    await sleep(500);
  }
  throw new Error(`status wait timeout for ${label}: ${JSON.stringify(latest)}`);
}

async function waitForLiveWorkers(
  client: GatewayClient,
  workers: string[],
  timeoutMs = 60_000,
): Promise<OrchestrationStatusResult> {
  return await waitForStatus(
    client,
    (status) => workers.every((workerId) => status.liveWorkers.includes(workerId)),
    timeoutMs,
    `live workers ${workers.join(",")}`,
  );
}

async function dispatchTask(
  client: GatewayClient,
  params: {
    idempotencyKey: string;
    message: string;
    sessionKey: string;
    targetWorkerId?: string;
    deliver?: boolean;
    timeoutMs?: number;
  },
): Promise<OrchestrationDispatchResult> {
  const res = await client.rpc("orchestration.dispatch", params, 30_000);
  if (!res.ok) {
    throw new Error(`orchestration.dispatch failed: ${frameErrorMessage(res)}`);
  }
  return res.payload as OrchestrationDispatchResult;
}

async function waitForTaskResult(
  client: GatewayClient,
  taskId: string,
  timeoutMs = 120_000,
): Promise<OrchestrationResultEvent> {
  return await client.waitEvent<OrchestrationResultEvent>(
    "orchestration.result",
    (payload) => {
      const task = (payload as { taskId?: string })?.taskId;
      return typeof task === "string" && task === taskId;
    },
    timeoutMs,
  );
}

async function waitForTaskResultOrNull(
  client: GatewayClient,
  taskId: string,
  timeoutMs: number,
): Promise<OrchestrationResultEvent | null> {
  try {
    return await waitForTaskResult(client, taskId, timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("event timeout")) {
      return null;
    }
    throw err;
  }
}

async function waitForAllTaskResults(
  client: GatewayClient,
  taskIds: Iterable<string>,
  timeoutMs: number,
): Promise<Map<string, OrchestrationResultEvent>> {
  const pending = new Set<string>(taskIds);
  const results = new Map<string, OrchestrationResultEvent>();
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for task results: ${JSON.stringify([...pending])}`);
    }
    const result = await client.waitEvent<OrchestrationResultEvent>(
      "orchestration.result",
      (payload) => {
        const task = (payload as { taskId?: string })?.taskId;
        return typeof task === "string" && pending.has(task);
      },
      remaining,
    );
    pending.delete(result.taskId);
    results.set(result.taskId, result);
  }
  return results;
}

function configureRiceEnvForReadback(): void {
  if (riceEndpoint) {
    process.env.STATE_INSTANCE_URL = riceEndpoint;
    process.env.STORAGE_INSTANCE_URL = riceEndpoint;
  } else {
    process.env.STATE_INSTANCE_URL = stateInstanceUrl;
    process.env.STORAGE_INSTANCE_URL = storageInstanceUrl;
  }
  if (stateAuthToken) {
    process.env.STATE_AUTH_TOKEN = stateAuthToken;
  }
  if (storageAuthToken) {
    process.env.STORAGE_AUTH_TOKEN = storageAuthToken;
  }
  if (storageHttpPort) {
    process.env.STORAGE_HTTP_PORT = storageHttpPort;
  }
}

async function createRiceClient(): Promise<Client> {
  configureRiceEnvForReadback();
  const riceConfigPath = await ensureRiceSdkConfigPath();
  const rice = new Client({
    configPath: riceConfigPath,
    runId,
    stateRunId: runId,
    storageRunId: runId,
  });
  await rice.connect();
  return rice;
}

function isVariableNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === 5) {
    return true;
  }
  const message = String((err as { message?: unknown }).message ?? "");
  return message.toLowerCase().includes("not found");
}

async function getVariableOrNull(rice: Client, key: string): Promise<{ name?: string } | null> {
  try {
    return await rice.state.getVariable(key);
  } catch (err) {
    if (isVariableNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

async function assertResultPersisted(taskId: string): Promise<void> {
  const rice = await createRiceClient();
  const variableName = `oc.orch.result.${taskId}`;
  const variable = await getVariableOrNull(rice, variableName);
  assertCondition(variable?.name === variableName, `missing Rice result variable ${variableName}`);
}

async function waitForVariablesAbsent(
  rice: Client,
  keys: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(keys.map(async (key) => await getVariableOrNull(rice, key)));
    const remaining = keys.filter((_, idx) => states[idx]?.name);
    if (remaining.length === 0) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for variables to expire: ${JSON.stringify(keys)}`);
}

async function phaseBaseline(): Promise<void> {
  const primary = await GatewayClient.connect({
    url: gatewayUrl,
    token: gatewayToken,
    label: "baseline-primary",
  });
  const observer = await GatewayClient.connect({
    url: gatewayUrl,
    token: gatewayToken,
    label: "baseline-observer",
  });

  try {
    await waitForLiveWorkers(primary, ["worker-a", "worker-b"], 60_000);
    console.log("[extended] both workers live");

    const workflowPrefix = randomKey("workflow");
    const stepA = await dispatchTask(primary, {
      idempotencyKey: `${workflowPrefix}-step-a`,
      message: `workflow ${workflowPrefix} step A`,
      sessionKey: "agent:main:main",
      targetWorkerId: "worker-a",
      deliver: false,
      timeoutMs: 120_000,
    });
    const stepB = await dispatchTask(primary, {
      idempotencyKey: `${workflowPrefix}-step-b`,
      message: `workflow ${workflowPrefix} step B`,
      sessionKey: "agent:main:main",
      targetWorkerId: "worker-b",
      deliver: false,
      timeoutMs: 120_000,
    });
    assertCondition(
      stepA.status === "accepted",
      `expected accepted for stepA: ${JSON.stringify(stepA)}`,
    );
    assertCondition(
      stepB.status === "accepted",
      `expected accepted for stepB: ${JSON.stringify(stepB)}`,
    );
    assertCondition(stepA.targetWorkerId === "worker-a", `stepA routed to ${stepA.targetWorkerId}`);
    assertCondition(stepB.targetWorkerId === "worker-b", `stepB routed to ${stepB.targetWorkerId}`);

    const stepAResult = await waitForTaskResult(primary, stepA.taskId);
    const stepBResult = await waitForTaskResult(primary, stepB.taskId);
    assertCondition(stepAResult.targetWorkerId === "worker-a", "stepA result target mismatch");
    assertCondition(stepBResult.targetWorkerId === "worker-b", "stepB result target mismatch");
    console.log("[extended] targeted split workflow completed");

    const isolated = await dispatchTask(primary, {
      idempotencyKey: randomKey("isolation"),
      message: "requester fanout isolation check",
      sessionKey: "agent:main:main",
      deliver: false,
      timeoutMs: 120_000,
    });
    assertCondition(
      isolated.status === "accepted",
      `expected accepted isolation dispatch: ${JSON.stringify(isolated)}`,
    );
    const requesterResultPromise = waitForTaskResult(primary, isolated.taskId);
    const observerResultPromise = waitForTaskResultOrNull(observer, isolated.taskId, 6_000);
    const requesterResult = await requesterResultPromise;
    const observerResult = await observerResultPromise;
    assertCondition(
      requesterResult.taskId === isolated.taskId,
      "requester did not receive expected result event",
    );
    assertCondition(
      observerResult === null,
      `observer unexpectedly received requester-specific result: ${JSON.stringify(observerResult)}`,
    );
    console.log("[extended] requester-only result fanout verified");

    const burstKeys = Array.from({ length: burstCount }, (_, idx) => randomKey(`burst-${idx}`));
    const burstDispatches = await Promise.all(
      burstKeys.map(
        async (idempotencyKey) =>
          await dispatchTask(primary, {
            idempotencyKey,
            message: `burst task ${idempotencyKey}`,
            sessionKey: "agent:main:main",
            deliver: false,
            timeoutMs: 120_000,
          }),
      ),
    );
    for (const item of burstDispatches) {
      assertCondition(
        item.status === "accepted",
        `unexpected burst dispatch status: ${JSON.stringify(item)}`,
      );
    }
    const workerCounts = new Map<string, number>();
    for (const item of burstDispatches) {
      workerCounts.set(item.targetWorkerId, (workerCounts.get(item.targetWorkerId) ?? 0) + 1);
    }
    const countA = workerCounts.get("worker-a") ?? 0;
    const countB = workerCounts.get("worker-b") ?? 0;
    assertCondition(
      countA > 0 && countB > 0,
      `burst routing did not hit both workers: ${JSON.stringify([...workerCounts])}`,
    );
    assertCondition(
      Math.abs(countA - countB) <= 1,
      `burst routing not balanced (expected round-robin): worker-a=${countA}, worker-b=${countB}`,
    );
    await waitForAllTaskResults(
      primary,
      burstDispatches.map((item) => item.taskId),
      180_000,
    );
    console.log(`[extended] burst routing/results verified (${burstCount} tasks)`);

    const dedupeKey = randomKey("dedupe");
    const first = await dispatchTask(primary, {
      idempotencyKey: dedupeKey,
      message: "dedupe warm-up",
      sessionKey: "agent:main:main",
      deliver: false,
      timeoutMs: 120_000,
    });
    assertCondition(
      first.status === "accepted",
      `expected accepted dedupe warm-up: ${JSON.stringify(first)}`,
    );
    const duplicates = await Promise.all(
      Array.from(
        { length: 8 },
        async () =>
          await dispatchTask(primary, {
            idempotencyKey: dedupeKey,
            message: "dedupe warm-up",
            sessionKey: "agent:main:main",
            deliver: false,
            timeoutMs: 120_000,
          }),
      ),
    );
    for (const duplicate of duplicates) {
      assertCondition(
        duplicate.status === "deduped",
        `expected deduped status: ${JSON.stringify(duplicate)}`,
      );
      assertCondition(
        duplicate.taskId === first.taskId,
        `dedupe taskId mismatch: ${JSON.stringify(duplicate)}`,
      );
    }
    await waitForTaskResult(primary, first.taskId, 120_000);
    console.log("[extended] concurrent dedupe after initial acceptance verified");

    await assertResultPersisted(stepA.taskId);
    console.log("[extended] Rice result persistence verified");
  } finally {
    await primary.close();
    await observer.close();
  }
}

async function phaseWorkerBDown(): Promise<void> {
  const primary = await GatewayClient.connect({
    url: gatewayUrl,
    token: gatewayToken,
    label: "worker-b-down",
  });
  try {
    await waitForStatus(
      primary,
      (status) =>
        status.liveWorkers.includes("worker-a") && !status.liveWorkers.includes("worker-b"),
      45_000,
      "worker-b to be considered offline",
    );
    console.log("[extended] worker-b marked offline by heartbeat TTL");

    const targetedDown = await primary.rpc(
      "orchestration.dispatch",
      {
        idempotencyKey: randomKey("down-target"),
        message: "target down worker",
        sessionKey: "agent:main:main",
        targetWorkerId: "worker-b",
        deliver: false,
      },
      20_000,
    );
    assertCondition(
      !targetedDown.ok,
      `targeted dispatch to down worker should fail: ${JSON.stringify(targetedDown)}`,
    );
    const downMessage = (targetedDown.error?.message ?? "").toLowerCase();
    assertCondition(
      downMessage.includes("not live"),
      `expected not-live error for down worker, got: ${JSON.stringify(targetedDown.error)}`,
    );

    const failoverDispatches = await Promise.all(
      Array.from(
        { length: 6 },
        async (_, idx) =>
          await dispatchTask(primary, {
            idempotencyKey: randomKey(`failover-${idx}`),
            message: `failover task ${idx}`,
            sessionKey: "agent:main:main",
            deliver: false,
            timeoutMs: 120_000,
          }),
      ),
    );
    for (const item of failoverDispatches) {
      assertCondition(
        item.status === "accepted",
        `unexpected failover status: ${JSON.stringify(item)}`,
      );
      assertCondition(
        item.targetWorkerId === "worker-a",
        `failover routed to non-live worker: ${JSON.stringify(item)}`,
      );
    }
    await waitForAllTaskResults(
      primary,
      failoverDispatches.map((item) => item.taskId),
      180_000,
    );
    console.log("[extended] failover routing to worker-a verified");
  } finally {
    await primary.close();
  }
}

async function phaseWorkerBUp(): Promise<void> {
  const primary = await GatewayClient.connect({
    url: gatewayUrl,
    token: gatewayToken,
    label: "worker-b-up",
  });
  try {
    await waitForLiveWorkers(primary, ["worker-a", "worker-b"], 60_000);
    console.log("[extended] worker-b recovered");

    const targetB = await dispatchTask(primary, {
      idempotencyKey: randomKey("recover-b"),
      message: "worker-b recovery targeted task",
      sessionKey: "agent:main:main",
      targetWorkerId: "worker-b",
      deliver: false,
      timeoutMs: 120_000,
    });
    assertCondition(
      targetB.status === "accepted",
      `target worker-b dispatch failed: ${JSON.stringify(targetB)}`,
    );
    assertCondition(
      targetB.targetWorkerId === "worker-b",
      `target worker-b routed incorrectly: ${JSON.stringify(targetB)}`,
    );
    const resultB = await waitForTaskResult(primary, targetB.taskId, 120_000);
    assertCondition(
      resultB.targetWorkerId === "worker-b",
      `result target mismatch for worker-b recovery: ${JSON.stringify(resultB)}`,
    );

    const targetA = await dispatchTask(primary, {
      idempotencyKey: randomKey("recover-a"),
      message: "worker-a sanity task",
      sessionKey: "agent:main:main",
      targetWorkerId: "worker-a",
      deliver: false,
      timeoutMs: 120_000,
    });
    assertCondition(
      targetA.status === "accepted",
      `target worker-a dispatch failed: ${JSON.stringify(targetA)}`,
    );
    assertCondition(
      targetA.targetWorkerId === "worker-a",
      `target worker-a routed incorrectly: ${JSON.stringify(targetA)}`,
    );
    const resultA = await waitForTaskResult(primary, targetA.taskId, 120_000);
    assertCondition(
      resultA.targetWorkerId === "worker-a",
      `result target mismatch for worker-a sanity: ${JSON.stringify(resultA)}`,
    );
    console.log("[extended] both workers execute targeted tasks after recovery");
  } finally {
    await primary.close();
  }
}

async function phasePostOrchestratorRestart(): Promise<void> {
  const primary = await GatewayClient.connect({
    url: gatewayUrl,
    token: gatewayToken,
    label: "post-orchestrator-restart",
  });
  try {
    const status = await waitForLiveWorkers(primary, ["worker-a", "worker-b"], 60_000);
    assertCondition(status.enabled === true, "orchestration should stay enabled after restart");
    assertCondition(
      status.role === "orchestrator",
      `unexpected role after restart: ${status.role}`,
    );

    const dispatch = await dispatchTask(primary, {
      idempotencyKey: randomKey("post-restart"),
      message: "post orchestrator restart task",
      sessionKey: "agent:main:main",
      deliver: false,
      timeoutMs: 120_000,
    });
    assertCondition(
      dispatch.status === "accepted",
      `post-restart dispatch failed: ${JSON.stringify(dispatch)}`,
    );
    await waitForTaskResult(primary, dispatch.taskId, 120_000);
    console.log("[extended] orchestrator restart resilience verified");
  } finally {
    await primary.close();
  }
}

async function phaseRetentionCleanup(): Promise<void> {
  const retentionMs = parseRetentionMsOrThrow(retentionRaw);
  assertCondition(
    retentionMs <= 120_000,
    `retention phase expects ORCH_RETENTION <= 120s, got "${retentionRaw}"`,
  );

  const primary = await GatewayClient.connect({
    url: gatewayUrl,
    token: gatewayToken,
    label: "retention-cleanup",
  });
  try {
    await waitForLiveWorkers(primary, ["worker-a", "worker-b"], 60_000);
    const idempotencyKey = randomKey("retention");
    const dispatch = await dispatchTask(primary, {
      idempotencyKey,
      message: "retention cleanup verification task",
      sessionKey: "agent:main:main",
      deliver: false,
      timeoutMs: 120_000,
    });
    assertCondition(
      dispatch.status === "accepted",
      `retention dispatch failed: ${JSON.stringify(dispatch)}`,
    );
    const result = await waitForTaskResult(primary, dispatch.taskId, 120_000);
    assertCondition(result.taskId === dispatch.taskId, "retention result mismatch");

    const taskKey = `oc.orch.task.${dispatch.taskId}`;
    const resultKey = `oc.orch.result.${dispatch.taskId}`;
    const idemKey = `oc.orch.idem.${hashIdempotencyKey(idempotencyKey)}`;
    const rice = await createRiceClient();
    const seeded = await Promise.all(
      [taskKey, resultKey, idemKey].map(async (key) => await getVariableOrNull(rice, key)),
    );
    for (let idx = 0; idx < seeded.length; idx += 1) {
      assertCondition(
        seeded[idx]?.name,
        `expected variable to exist before expiry: ${[taskKey, resultKey, idemKey][idx]}`,
      );
    }

    const timeoutMs = Math.max(60_000, retentionMs + 45_000);
    await waitForVariablesAbsent(rice, [taskKey, resultKey, idemKey], timeoutMs);
    console.log(`[extended] retention cleanup verified (retention=${retentionRaw})`);
  } finally {
    await primary.close();
  }
}

switch (phase) {
  case "baseline":
    await phaseBaseline();
    break;
  case "worker-b-down":
    await phaseWorkerBDown();
    break;
  case "worker-b-up":
    await phaseWorkerBUp();
    break;
  case "post-orchestrator-restart":
    await phasePostOrchestratorRestart();
    break;
  case "retention-cleanup":
    await phaseRetentionCleanup();
    break;
  default:
    throw new Error(`unknown ORCH_EXT_PHASE: ${phase}`);
}

console.log(`[extended] phase ${phase} passed`);
