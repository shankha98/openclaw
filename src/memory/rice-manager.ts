import crypto from "node:crypto";
import { Client } from "rice-node-sdk";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedMemoryBackendConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemoryStoreRequest,
  MemoryStoreResult,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { ensureRiceSdkConfigPath } from "./rice-sdk-config.js";

const log = createSubsystemLogger("memory-rice");
const STORAGE_USER_ID = 1;
const STORAGE_PATH_PREFIX = "rice:storage/";
const STATE_PATH_PREFIX = "rice:state/";

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export class RiceMemoryManager implements MemorySearchManager {
  private readonly client: Client;
  private readonly workspaceDir: string;
  private readonly config: ResolvedMemoryBackendConfig;
  private readonly agentId: string;
  private dirty = false;
  private readonly readCache = new Map<string, string>();

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): Promise<RiceMemoryManager> {
    const config = resolveMemoryBackendConfig(params);
    if (config.backend !== "rice" || !config.rice) {
      throw new Error("Invalid configuration for Rice memory backend");
    }

    const riceConfigPath = await ensureRiceSdkConfigPath();
    const client = new Client({
      configPath: riceConfigPath,
      runId: config.rice.runId || params.agentId,
    });

    // Override endpoint if provided in config
    if (config.rice.endpoint) {
      process.env.STORAGE_INSTANCE_URL = config.rice.endpoint;
      process.env.STATE_INSTANCE_URL = config.rice.endpoint;
    }

    await client.connect();

    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const manager = new RiceMemoryManager(client, workspaceDir, config, params.agentId);

    if (config.rice.sync.enabled) {
      void manager.sync({ reason: "startup" });
    }

    return manager;
  }

  private constructor(
    client: Client,
    workspaceDir: string,
    config: ResolvedMemoryBackendConfig,
    agentId: string,
  ) {
    this.client = client;
    this.workspaceDir = workspaceDir;
    this.config = config;
    this.agentId = agentId;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];
    const limit = Math.max(1, Math.floor(opts?.maxResults ?? 5));
    const minScore = opts?.minScore ?? Number.NEGATIVE_INFINITY;
    this.readCache.clear();

    try {
      const storageResults = await this.searchStorage(query, limit);
      for (const rawItem of storageResults) {
        const anyItem = rawItem as Record<string, unknown>;
        const metadata = asRecord(anyItem.metadata);
        const text =
          readNonEmptyString(anyItem.data) ??
          readNonEmptyString(anyItem.text) ??
          readNonEmptyString(anyItem.content) ??
          readNonEmptyString(anyItem.chunk) ??
          "";
        if (!text) {
          continue;
        }
        const idValue = stringifyId(anyItem.id) ?? hashText(text).slice(0, 16);
        const path =
          readNonEmptyString(metadata.path) ??
          `${STORAGE_PATH_PREFIX}${encodeURIComponent(idValue)}`;
        const startLine = asPositiveInt(metadata.startLine) ?? 1;
        const endLine = asPositiveInt(metadata.endLine) ?? countLines(text);
        const score = asNumber(anyItem.similarity) ?? asNumber(anyItem.score) ?? 0;
        if (score < minScore) {
          continue;
        }
        results.push({
          path,
          startLine,
          endLine: Math.max(startLine, endLine),
          score,
          snippet: text,
          source: "memory",
        });
        this.readCache.set(path, text);
      }
    } catch (err) {
      log.error(`Storage search failed: ${String(err)}`);
    }

    try {
      if (this.config.rice?.enabled) {
        const memories = await this.client.state.reminisce(query, limit);
        for (let index = 0; index < memories.length; index += 1) {
          const anyMem = memories[index] as Record<string, unknown>;
          const trace = formatStateTrace(anyMem);
          if (!trace) {
            continue;
          }
          const id = hashText(JSON.stringify(anyMem)).slice(0, 16);
          const path = `${STATE_PATH_PREFIX}${id}`;
          const score =
            asNumber(anyMem.similarity) ??
            asNumber(anyMem.score) ??
            Math.max(0.1, 0.8 - index * 0.01);
          if (score < minScore) {
            continue;
          }
          results.push({
            path,
            startLine: 1,
            endLine: countLines(trace),
            score,
            snippet: trace,
            source: "sessions",
            citation: "Rice State",
          });
          this.readCache.set(path, trace);
        }
      }
    } catch (err) {
      log.error(`State search failed: ${String(err)}`);
    }

    return results.toSorted((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const requestedPath = params.relPath.trim();
    if (!requestedPath) {
      throw new Error("path required");
    }
    const normalizedPath = requestedPath.split("#", 1)[0] || requestedPath;
    const cached = this.readCache.get(requestedPath) ?? this.readCache.get(normalizedPath);
    if (!cached) {
      throw new Error("path required: use a path returned by memory_search");
    }

    if (params.from !== undefined || params.lines !== undefined) {
      const allLines = cached.split("\n");
      const start = Math.max(0, (params.from ?? 1) - 1);
      const lineCount = Math.max(1, params.lines ?? allLines.length);
      const end = start + lineCount;
      return {
        text: allLines.slice(start, end).join("\n"),
        path: normalizedPath,
      };
    }

    return { text: cached, path: normalizedPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "rice",
      provider: "rice-node-sdk",
      model: "state+storage",
      workspaceDir: this.workspaceDir,
      dirty: this.dirty,
      custom: {
        cachedEntries: this.readCache.size,
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    this.dirty = false;
    params?.progress?.({
      completed: 1,
      total: 1,
      label: "Rice memory backend is remote; local file sync skipped.",
    });
  }

  async store(params: MemoryStoreRequest): Promise<MemoryStoreResult> {
    const input = params.input.trim();
    if (!input) {
      throw new Error("input required");
    }
    const outcome = params.outcome?.trim() || "Stored in Rice state memory.";
    const action = params.action?.trim() || "memory_store";
    const reasoning = params.reasoning?.trim() || "Stored durable memory via memory_store tool";
    const ok = await this.client.state.commit(input, outcome, {
      action,
      reasoning,
      agent_id: this.agentId || "main",
    });
    return {
      ok,
      provider: "rice-node-sdk",
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      await this.client.state.drift();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      await this.client.storage.health();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.readCache.clear();
  }

  private async searchStorage(query: string, limit: number): Promise<unknown[]> {
    const search = this.client.storage.search.bind(this.client.storage) as (
      ...args: unknown[]
    ) => Promise<unknown[]>;
    try {
      return await search(query, STORAGE_USER_ID, limit);
    } catch (firstErr) {
      // Keep compatibility with SDK builds that expose a simplified search signature.
      try {
        return await search(query, limit);
      } catch {
        throw firstErr;
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asPositiveInt(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed === null) {
    return null;
  }
  const integer = Math.floor(parsed);
  return integer > 0 ? integer : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringifyId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const toStringFn = (value as { toString?: () => string }).toString;
  if (typeof toStringFn !== "function" || toStringFn === Object.prototype.toString) {
    return null;
  }
  const text = toStringFn.call(value);
  if (text && text !== "[object Object]") {
    return text;
  }
  return null;
}

function countLines(value: string): number {
  return Math.max(1, value.split("\n").length);
}

function formatStateTrace(value: Record<string, unknown>): string {
  const parts: string[] = [];
  const input = readNonEmptyString(value.input);
  const outcome = readNonEmptyString(value.outcome);
  const action = readNonEmptyString(value.action);
  const reasoning = readNonEmptyString(value.reasoning);
  const agentId = readNonEmptyString(value.agent_id);

  if (input) {
    parts.push(`Input: ${input}`);
  }
  if (outcome) {
    parts.push(`Outcome: ${outcome}`);
  }
  if (action) {
    parts.push(`Action: ${action}`);
  }
  if (reasoning) {
    parts.push(`Reasoning: ${reasoning}`);
  }
  if (agentId) {
    parts.push(`Agent: ${agentId}`);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join("\n");
}
