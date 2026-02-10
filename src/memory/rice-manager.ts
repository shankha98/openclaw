import chokidar, { type FSWatcher } from "chokidar";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "rice-node-sdk";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedMemoryBackendConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { chunkMarkdown, listMemoryFiles, type MemoryChunk } from "./internal.js";

const log = createSubsystemLogger("memory-rice");

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export class RiceMemoryManager implements MemorySearchManager {
  private readonly client: Client;
  private readonly workspaceDir: string;
  private readonly config: ResolvedMemoryBackendConfig;
  private watcher: FSWatcher | null = null;
  private syncing = false;
  private dirty = false;

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): Promise<RiceMemoryManager> {
    const config = resolveMemoryBackendConfig(params);
    if (config.backend !== "rice" || !config.rice) {
      throw new Error("Invalid configuration for Rice memory backend");
    }

    const client = new Client({
      configPath: undefined, // Uses default or env vars if not provided
      runId: config.rice.runId || params.agentId,
    });

    // Override endpoint if provided in config
    if (config.rice.endpoint) {
      process.env.STORAGE_INSTANCE_URL = config.rice.endpoint;
      process.env.STATE_INSTANCE_URL = config.rice.endpoint;
    }

    await client.connect();

    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const manager = new RiceMemoryManager(client, workspaceDir, config);

    if (config.rice.sync.enabled) {
      // Start sync in background
      void manager.startSync();
    }

    return manager;
  }

  private constructor(client: Client, workspaceDir: string, config: ResolvedMemoryBackendConfig) {
    this.client = client;
    this.workspaceDir = workspaceDir;
    this.config = config;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];
    const limit = opts?.maxResults || 5;

    try {
      // 1. Search Storage (RAG / Files)
      // client.storage.search returns Promise<any[]>
      const storageResults = await this.client.storage.search(query, limit);

      // Map storage results to MemorySearchResult
      // Assuming storage results have metadata with path/lines
      for (const item of storageResults) {
        // The SDK types might be loose, casting as any for now
        const anyItem = item as any;
        const metadata = anyItem.metadata || {};

        if (metadata.path) {
          // Try to find the text content in various fields
          const textContent =
            anyItem.text || anyItem.content || anyItem.chunk || anyItem.data || "";

          results.push({
            path: metadata.path,
            startLine: metadata.startLine || 1,
            endLine: metadata.endLine || 1,
            score: anyItem.score || 1.0, // Normalize if needed
            snippet: textContent,
            source: "memory",
          });
        }
      }

      // 2. Search State (Agent Memory)
      if (this.config.rice?.enabled) {
        // client.state.reminisce returns Promise<any[]>
        const memories = await this.client.state.reminisce(query, limit);
        for (const memory of memories) {
          const anyMem = memory as any;
          results.push({
            path: "agent:memory", // Virtual path
            startLine: 1,
            endLine: 1,
            score: anyMem.score || 0.8,
            snippet: anyMem.content || anyMem.text || JSON.stringify(anyMem),
            source: "sessions", // Closest mapping
            citation: "Agent Memory",
          });
        }
      }
    } catch (err) {
      log.error(`Search failed: ${err}`);
    }

    // Sort by score descending
    return results.toSorted((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    // Read from local filesystem as source of truth
    const absPath = path.resolve(this.workspaceDir, params.relPath);
    const content = await fs.readFile(absPath, "utf-8");

    // Simple line extraction
    if (params.from !== undefined || params.lines !== undefined) {
      const allLines = content.split("\n");
      const start = (params.from || 1) - 1;
      const end = start + (params.lines || allLines.length);
      return {
        text: allLines.slice(start, end).join("\n"),
        path: absPath,
      };
    }

    return { text: content, path: absPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "rice",
      provider: "rice-node-sdk",
      model: "default",
      workspaceDir: this.workspaceDir,
      dirty: this.dirty,
      // Add more specific status if needed
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.syncing && !params?.force) {
      return;
    }
    this.syncing = true;

    try {
      const files = await listMemoryFiles(this.workspaceDir);
      let processed = 0;

      for (const file of files) {
        const content = await fs.readFile(file, "utf-8");
        const relPath = path.relative(this.workspaceDir, file);

        // Chunk the file
        const chunks: MemoryChunk[] = chunkMarkdown(content, {
          tokens: 256, // Default token size
          overlap: 32,
        });

        for (const chunk of chunks) {
          // Unique ID for the chunk
          // We use hash of text to deduplicate, or path+lines to be specific
          // Using path+lines allows updating specific chunks
          const rawId = `${relPath}:${chunk.startLine}-${chunk.endLine}`;
          // Generate a deterministic 64-bit integer ID from the hash
          const hashHex = hashText(rawId).slice(0, 15); // 15 chars of hex is 60 bits, fits in u64 safely
          const id = BigInt(`0x${hashHex}`).toString();

          await this.client.storage.insert(id, chunk.text, {
            path: relPath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            source: "file",
          });
        }

        processed++;
        params?.progress?.({ completed: processed, total: files.length });
      }

      this.dirty = false;
    } catch (err) {
      log.error(`Sync failed: ${err}`);
    } finally {
      this.syncing = false;
    }
  }

  async startSync() {
    // Initial sync
    await this.sync({ reason: "startup" });

    // Watch for changes
    this.watcher = chokidar.watch(this.workspaceDir, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on("all", (event, path) => {
      if (path.endsWith(".md")) {
        this.dirty = true;
        // Debounce sync logic could go here
        void this.sync({ reason: "file-change" });
      }
    });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    await this.watcher?.close();
  }
}
