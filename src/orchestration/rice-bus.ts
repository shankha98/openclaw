import { Client } from "rice-node-sdk";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureRiceSdkConfigPath } from "../memory/rice-sdk-config.js";

const log = createSubsystemLogger("orchestration-rice");

export type RiceVariableRecord = {
  name: string;
  value: unknown;
  valueJson?: string;
  createdAt?: string;
  lastUpdated?: string;
  source?: string;
  raw: Record<string, unknown>;
};

export type RiceVariableUpdateEvent = {
  type: string;
  name?: string;
  value?: unknown;
};

export type OrchestrationBus = {
  connect: () => Promise<void>;
  setVariable: (name: string, value: unknown, source?: string) => Promise<boolean>;
  getVariable: (name: string) => Promise<RiceVariableRecord | null>;
  listVariables: () => Promise<RiceVariableRecord[]>;
  deleteVariable: (name: string) => Promise<boolean>;
  subscribeVariableUpdates: (listener: (evt: RiceVariableUpdateEvent) => void) => () => void;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJson(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeVariableRecord(raw: unknown): RiceVariableRecord | null {
  const obj = toRecord(raw);
  if (!obj) {
    return null;
  }
  const name =
    readNonEmptyString(obj.name) ??
    readNonEmptyString(obj.variable_name) ??
    readNonEmptyString(obj.variableName);
  if (!name) {
    return null;
  }
  const valueJson = readNonEmptyString(obj.value_json) ?? readNonEmptyString(obj.valueJson);
  const value =
    parseJson(valueJson) ?? obj.value ?? parseJson(readNonEmptyString(obj.payload)) ?? undefined;
  return {
    name,
    value,
    valueJson,
    createdAt: readNonEmptyString(obj.created_at) ?? readNonEmptyString(obj.createdAt),
    lastUpdated: readNonEmptyString(obj.last_updated) ?? readNonEmptyString(obj.lastUpdated),
    source: readNonEmptyString(obj.source),
    raw: obj,
  };
}

function parseVariableUpdateEvent(raw: unknown): RiceVariableUpdateEvent {
  const obj = toRecord(raw);
  if (!obj) {
    return { type: "unknown" };
  }
  const type = readNonEmptyString(obj.type) ?? "unknown";
  const payloadRaw = obj.payload;
  const payloadJson =
    typeof payloadRaw === "string"
      ? parseJson(payloadRaw)
      : typeof payloadRaw === "object"
        ? payloadRaw
        : undefined;
  const payload = toRecord(payloadJson);

  const directName =
    readNonEmptyString(obj.name) ??
    readNonEmptyString(obj.variable_name) ??
    readNonEmptyString(obj.variableName);
  const payloadName =
    readNonEmptyString(payload?.name) ??
    readNonEmptyString(payload?.variable_name) ??
    readNonEmptyString(payload?.variableName);
  const variableObj = toRecord(payload?.variable);
  const nestedName =
    readNonEmptyString(variableObj?.name) ??
    readNonEmptyString(variableObj?.variable_name) ??
    readNonEmptyString(variableObj?.variableName);
  const name = directName ?? payloadName ?? nestedName;

  const directValueJson =
    readNonEmptyString(obj.value_json) ??
    readNonEmptyString(obj.valueJson) ??
    readNonEmptyString(payload?.value_json) ??
    readNonEmptyString(payload?.valueJson) ??
    readNonEmptyString(variableObj?.value_json) ??
    readNonEmptyString(variableObj?.valueJson);
  const directValue =
    obj.value ??
    payload?.value ??
    variableObj?.value ??
    parseJson(directValueJson) ??
    parseJson(readNonEmptyString(payload?.payload));

  return {
    type,
    name,
    value: directValue,
  };
}

export class RiceOrchestrationBus implements OrchestrationBus {
  private readonly client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  static async create(params: { runId: string; endpoint?: string }): Promise<RiceOrchestrationBus> {
    const configPath = await ensureRiceSdkConfigPath();
    const client = new Client({
      configPath,
      runId: params.runId,
      stateRunId: params.runId,
      storageRunId: params.runId,
    });
    if (params.endpoint) {
      process.env.STATE_INSTANCE_URL = params.endpoint;
      process.env.STORAGE_INSTANCE_URL = params.endpoint;
    }
    await client.connect();
    return new RiceOrchestrationBus(client);
  }

  async connect(): Promise<void> {
    // Already connected in `create`; kept for interface symmetry.
  }

  async setVariable(
    name: string,
    value: unknown,
    source = "openclaw.orchestration",
  ): Promise<boolean> {
    return await this.client.state.setVariable(name, value, source);
  }

  async getVariable(name: string): Promise<RiceVariableRecord | null> {
    try {
      const raw = await this.client.state.getVariable(name);
      return normalizeVariableRecord(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message.toLowerCase() : "";
      if (message.includes("not found") || message.includes("notfound")) {
        return null;
      }
      throw err;
    }
  }

  async listVariables(): Promise<RiceVariableRecord[]> {
    const raw = await this.client.state.listVariables();
    return raw
      .map((entry) => normalizeVariableRecord(entry))
      .filter((entry): entry is RiceVariableRecord => Boolean(entry));
  }

  async deleteVariable(name: string): Promise<boolean> {
    return await this.client.state.deleteVariable(name);
  }

  subscribeVariableUpdates(listener: (evt: RiceVariableUpdateEvent) => void): () => void {
    const stream = this.client.state.subscribe(["VariableUpdate"]);
    const onData = (raw: unknown) => {
      try {
        const evt = parseVariableUpdateEvent(raw);
        if (evt.type === "VariableUpdate") {
          listener(evt);
        }
      } catch (err) {
        log.warn(`failed to parse VariableUpdate event: ${String(err)}`);
      }
    };
    const onError = (err: unknown) => {
      log.warn(`VariableUpdate stream error: ${String(err)}`);
    };
    stream.on("data", onData);
    stream.on("error", onError);

    return () => {
      try {
        stream.off("data", onData);
        stream.off("error", onError);
      } catch {
        // ignore
      }
      const maybeStream = stream as {
        cancel?: () => void;
        destroy?: () => void;
        end?: () => void;
      };
      try {
        if (typeof maybeStream.cancel === "function") {
          maybeStream.cancel();
        } else if (typeof maybeStream.destroy === "function") {
          maybeStream.destroy();
        } else if (typeof maybeStream.end === "function") {
          maybeStream.end();
        }
      } catch {
        // ignore
      }
    };
  }
}
