import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "rice-node-sdk";
import {
  classifyOpenClawMemoryPath,
  inferOpenClawSearchTypes,
} from "../src/memory/rice-smoke-utils.js";

type CliArgs = {
  runId: string;
  stateRunId?: string;
  storageRunId?: string;
  query?: string;
};

const RICE_CONFIG_BODY = `module.exports = {
  storage: { enabled: true },
  state: { enabled: true },
};
`;

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const parsed: CliArgs = {
    runId: process.env.STATE_RUN_ID?.trim() || "openclaw-rice-smoke",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run-id") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error("--run-id requires a value");
      }
      parsed.runId = value;
      index += 1;
      continue;
    }
    if (arg === "--query") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error("--query requires a value");
      }
      parsed.query = value;
      index += 1;
      continue;
    }
    if (arg === "--state-run-id") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error("--state-run-id requires a value");
      }
      parsed.stateRunId = value;
      index += 1;
      continue;
    }
    if (arg === "--storage-run-id") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error("--storage-run-id requires a value");
      }
      parsed.storageRunId = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage(): void {
  console.log(
    [
      "Usage: bun scripts/rice-memory-smoke.ts [--run-id <id>] [--state-run-id <id>] [--storage-run-id <id>] [--query <query>]",
      "",
      "Environment:",
      "  STATE_INSTANCE_URL, STATE_AUTH_TOKEN, STORAGE_INSTANCE_URL, STORAGE_AUTH_TOKEN",
      "",
      "Examples:",
      "  bun scripts/rice-memory-smoke.ts",
      "  bun scripts/rice-memory-smoke.ts --run-id agent:main:main",
      "  bun scripts/rice-memory-smoke.ts --state-run-id state-a --storage-run-id storage-a",
    ].join("\n"),
  );
}

async function writeTempRiceConfig(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rice-smoke-"));
  const configPath = path.join(dir, "rice.config.js");
  await fs.writeFile(configPath, RICE_CONFIG_BODY, "utf8");
  return configPath;
}

function generateToken(): string {
  return `openclaw-rice-smoke-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function generateNumericNodeId(): string {
  // Keep IDs <= Number.MAX_SAFE_INTEGER because the SDK HTTP transport
  // currently serializes IDs as JSON numbers.
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000);
  return String(ts * 1000 + rand);
}

function readTextField(record: Record<string, unknown>): string {
  const candidate = record.data ?? record.text ?? record.content ?? record.chunk ?? "";
  if (typeof candidate === "string") {
    return candidate;
  }
  try {
    return JSON.stringify(candidate);
  } catch {
    return "<non-serializable>";
  }
}

function stringifyNodeId(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
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
  return text && text !== "[object Object]" ? text : null;
}

async function searchStorageWithCompatibility(
  client: Client,
  query: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const search = client.storage.search.bind(client.storage) as (
    ...args: unknown[]
  ) => Promise<Array<Record<string, unknown>>>;
  try {
    // RiceDBClient signature: search(query, userId, k)
    return await search(query, 1, limit);
  } catch {
    // Compatibility fallback for SDK variants with simplified signature.
    return await search(query, limit);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const configPath = await writeTempRiceConfig();
  const token = generateToken();
  const insertedId = generateNumericNodeId();
  const query = args.query ?? token;

  const client = new Client({
    configPath,
    runId: args.runId,
    stateRunId: args.stateRunId,
    storageRunId: args.storageRunId,
  });
  await client.connect();

  await client.storage.insert(insertedId, `OpenClaw Rice smoke test payload ${token}`, {
    source: "openclaw-rice-smoke",
    token,
    insertedAt: new Date().toISOString(),
  });

  await client.state.focus(`OpenClaw smoke focus ${token}`);
  await client.state.commit(
    `OpenClaw smoke state input ${token}`,
    `OpenClaw smoke state output ${token}`,
    {
      action: "smoke_test",
      reasoning: "Standalone Rice smoke test",
      agent_id: args.runId,
    },
  );

  const storageHits = await searchStorageWithCompatibility(client, query, 10);
  const stateHits = (await client.state.reminisce(query, 10)) as Array<Record<string, unknown>>;

  const openclawLikePaths = storageHits.map((hit) => {
    const metadata = hit.metadata;
    const metadataRecord =
      metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
    const id = stringifyNodeId(hit.id);
    const defaultPath = id ? `rice:storage/${id}` : "rice:storage/unknown";
    const pathValue = metadataRecord.path;
    return {
      path: typeof pathValue === "string" && pathValue.trim() ? pathValue : defaultPath,
    };
  });

  const inferredOpenClawTypes = inferOpenClawSearchTypes(openclawLikePaths);

  const output = {
    ok: true,
    provider: "rice-node-sdk",
    runId: args.runId,
    stateRunId: args.stateRunId ?? null,
    storageRunId: args.storageRunId ?? null,
    token,
    configPath,
    storage: {
      insertedId,
      hitCount: storageHits.length,
      firstHitPreview: storageHits[0]
        ? {
            id: stringifyNodeId(storageHits[0].id) ?? "unknown",
            text: readTextField(storageHits[0]).slice(0, 200),
          }
        : null,
    },
    state: {
      hitCount: stateHits.length,
      firstHitPreview: stateHits[0]
        ? {
            input: typeof stateHits[0].input === "string" ? stateHits[0].input : null,
            output: typeof stateHits[0].output === "string" ? stateHits[0].output : null,
          }
        : null,
    },
    openclawPathTypes: {
      samples: openclawLikePaths.map((entry) => ({
        path: entry.path,
        type: classifyOpenClawMemoryPath(entry.path),
      })),
      inferred: inferredOpenClawTypes,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`rice-memory-smoke failed: ${message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main();
}
