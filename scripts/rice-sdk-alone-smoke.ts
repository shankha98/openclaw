import { parse } from "dotenv";
import Long from "long";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "rice-node-sdk";

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
const REQUIRED_ENV_KEYS = [
  "STORAGE_INSTANCE_URL",
  "STORAGE_AUTH_TOKEN",
  "STATE_INSTANCE_URL",
  "STATE_AUTH_TOKEN",
] as const;

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const parsed: CliArgs = {
    runId: process.env.STATE_RUN_ID?.trim() || "rice-sdk-alone-smoke",
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
      "Usage: bun scripts/rice-sdk-alone-smoke.ts [--run-id <id>] [--state-run-id <id>] [--storage-run-id <id>] [--query <query>]",
      "",
      "Required env:",
      "  STORAGE_INSTANCE_URL, STORAGE_AUTH_TOKEN, STATE_INSTANCE_URL, STATE_AUTH_TOKEN",
      "",
      "Examples:",
      "  pnpm rice:sdk:smoke",
      "  pnpm rice:sdk:smoke -- --run-id agent:main:main",
      "  pnpm rice:sdk:smoke -- --state-run-id state-a --storage-run-id storage-a",
    ].join("\n"),
  );
}

async function writeTempRiceConfig(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rice-sdk-alone-"));
  const configPath = path.join(dir, "rice.config.js");
  await fs.writeFile(configPath, RICE_CONFIG_BODY, "utf8");
  return configPath;
}

async function loadRiceEnvFromDotenv(): Promise<string> {
  const envPath = path.resolve(process.cwd(), ".env");
  const raw = await fs.readFile(envPath, "utf8");
  const parsed = parse(raw);

  for (const key of REQUIRED_ENV_KEYS) {
    const value = parsed[key]?.trim();
    if (!value) {
      throw new Error(`Missing ${key} in ${envPath}`);
    }
    process.env[key] = value;
  }

  return envPath;
}

function generateToken(): string {
  return `rice-sdk-alone-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function generateNumericNodeId(): string {
  // Keep IDs <= Number.MAX_SAFE_INTEGER because the SDK HTTP transport
  // currently serializes IDs as JSON numbers.
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000);
  return String(ts * 1000 + rand);
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

function normalizeId(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Long.isLong(value)) {
    return value.toString();
  }
  return "";
}

function extractInsertedNodeId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return normalizeId(record.nodeId ?? record.node_id) || null;
}

function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Long.isLong(value)) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonSafe(entry));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toJsonSafe(entry);
    }
    return output;
  }
  return "<unsupported-type>";
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const envPath = await loadRiceEnvFromDotenv();
  const configPath = await writeTempRiceConfig();
  const token = generateToken();
  const query = args.query ?? token;

  const storageId = generateNumericNodeId();
  const storageText = `Rice SDK standalone smoke payload ${token}`;
  const storageInsertMetadata = {
    source: "rice-sdk-alone-smoke",
    token,
    insertedAt: new Date().toISOString(),
  };
  const stateFocusInput = `Standalone SDK focus ${token}`;
  const stateCommitInput = `Standalone SDK input ${token}`;
  const stateCommitOutput = `Standalone SDK output ${token}`;
  const searchLimit = 10;

  const client = new Client({
    configPath,
    runId: args.runId,
    stateRunId: args.stateRunId,
    storageRunId: args.storageRunId,
  });
  await client.connect();

  const storageInsertResult = await client.storage.insert(
    storageId,
    storageText,
    storageInsertMetadata,
  );
  const returnedStorageNodeId = extractInsertedNodeId(storageInsertResult);

  const stateFocusResult = await client.state.focus(stateFocusInput);
  const stateCommitResult = await client.state.commit(stateCommitInput, stateCommitOutput, {
    action: "sdk_smoke_test",
    reasoning: "Verify Rice SDK insert + retrieve",
    agent_id: args.runId,
  });

  const storageHits = await searchStorageWithCompatibility(client, query, searchLimit);
  const stateHits = (await client.state.reminisce(query, searchLimit)) as Array<
    Record<string, unknown>
  >;

  const output = {
    ok: true,
    provider: "rice-node-sdk",
    runId: args.runId,
    token,
    envPath,
    input: {
      runId: args.runId,
      stateRunId: args.stateRunId ?? null,
      storageRunId: args.storageRunId ?? null,
      query,
      searchLimit,
      storageInsert: {
        id: storageId,
        text: storageText,
        metadata: storageInsertMetadata,
      },
      stateFocus: {
        content: stateFocusInput,
      },
      stateCommit: {
        input: stateCommitInput,
        output: stateCommitOutput,
        options: {
          action: "sdk_smoke_test",
          reasoning: "Verify Rice SDK insert + retrieve",
          agent_id: args.runId,
        },
      },
    },
    inserted: {
      requestedStorageId: storageId,
      returnedStorageNodeId,
      storageText,
    },
    retrieved: {
      storageHitCount: storageHits.length,
      stateHitCount: stateHits.length,
      storageFoundRequestedId: storageHits.some((hit) => normalizeId(hit.id) === storageId),
      storageFoundReturnedId: returnedStorageNodeId
        ? storageHits.some((hit) => normalizeId(hit.id) === returnedStorageNodeId)
        : false,
      storageFoundToken: storageHits.some((hit) => JSON.stringify(hit).includes(token)),
      stateFoundToken: stateHits.some((hit) => JSON.stringify(hit).includes(token)),
    },
    output: {
      storageInsertResult: toJsonSafe(storageInsertResult),
      stateFocusResult: toJsonSafe(stateFocusResult),
      stateCommitResult: toJsonSafe(stateCommitResult),
      searchResults: {
        storage: toJsonSafe(storageHits),
        state: toJsonSafe(stateHits),
      },
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`rice-sdk-alone-smoke failed: ${message}`);
    process.exitCode = 1;
  }
}

void main();
