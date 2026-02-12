import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestrationTaskEnvelope } from "./types.js";
import { createDefaultDeps } from "../cli/deps.js";
import { installOpenAiResponsesMock } from "../gateway/test-helpers.openai-mock.js";
import { createWorkerTaskExecutor } from "./worker.js";

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((payload) =>
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).text
        : undefined,
    )
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  return texts.join("\n").trim();
}

describe("orchestration worker quality e2e", () => {
  it("executes a tool call and returns expected output content", { timeout: 90_000 }, async () => {
    const prev = {
      home: process.env.HOME,
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
      skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
      skipCron: process.env.OPENCLAW_SKIP_CRON,
      skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
      skipBrowser: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
    };

    const { baseUrl: openaiBaseUrl, restore } = installOpenAiResponsesMock();
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orch-worker-quality-"));

    process.env.HOME = tempHome;
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";

    const workspaceDir = path.join(tempHome, "openclaw");
    await fs.mkdir(workspaceDir, { recursive: true });
    const nonceA = randomUUID();
    const nonceB = randomUUID();
    const probePath = path.join(workspaceDir, `.openclaw-orch-tool-probe.${nonceA}.txt`);
    await fs.writeFile(probePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

    const configDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "openai/gpt-5.2",
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          openai: {
            baseUrl: openaiBaseUrl,
            apiKey: "test",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.2",
                name: "gpt-5.2",
                api: "openai-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };

    await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    try {
      const task: OrchestrationTaskEnvelope = {
        schemaVersion: 1,
        taskId: randomUUID(),
        idempotencyKey: `idem-${randomUUID()}`,
        clusterId: "local-dev",
        targetWorkerId: "worker-a",
        sessionKey: "agent:dev:orchestration-quality",
        message:
          `Call the read tool on "${probePath}". ` +
          `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
        timeoutMs: 60_000,
        attempt: 1,
        createdAt: new Date().toISOString(),
        createdBy: "test",
        deliver: false,
      };

      const executeTask = createWorkerTaskExecutor({
        workerId: "worker-a",
        deps: createDefaultDeps(),
      });
      const result = await executeTask(task);

      expect(result.status).toBe("ok");
      const outputText = extractPayloadText(result.result);
      expect(outputText).toContain(nonceA);
      expect(outputText).toContain(nonceB);
    } finally {
      restore();
      await fs.rm(tempHome, { recursive: true, force: true });
      process.env.HOME = prev.home;
      process.env.OPENCLAW_CONFIG_PATH = prev.configPath;
      process.env.OPENCLAW_SKIP_CHANNELS = prev.skipChannels;
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = prev.skipGmail;
      process.env.OPENCLAW_SKIP_CRON = prev.skipCron;
      process.env.OPENCLAW_SKIP_CANVAS_HOST = prev.skipCanvas;
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = prev.skipBrowser;
    }
  });
});
