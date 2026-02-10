/**
 * Session memory hook handler
 *
 * Saves session context to Rice State memory when /new command is triggered.
 */

import fs from "node:fs/promises";
import { Client } from "rice-node-sdk";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { ensureRiceSdkConfigPath } from "../../../memory/rice-sdk-config.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";

const log = createSubsystemLogger("hooks/session-memory");

/**
 * Read recent messages from session file for slug generation
 */
async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    // Parse JSONL and extract user/assistant messages first
    const allMessages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Session files have entries with type="message" containing a nested message object
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            // Extract text content
            const text = Array.isArray(msg.content)
              ? // oxlint-disable-next-line typescript/no-explicit-any
                msg.content.find((c: any) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              allMessages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    // Then slice to get exactly messageCount messages
    const recentMessages = allMessages.slice(-messageCount);
    return recentMessages.join("\n");
  } catch {
    return null;
  }
}

/**
 * Save session context to Rice state when /new command is triggered.
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  try {
    log.debug("Hook triggered for /new command");

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);

    // Get today's date for metadata
    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

    // Generate descriptive slug from session using LLM
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const currentSessionId = sessionEntry.sessionId as string;
    const currentSessionFile = sessionEntry.sessionFile as string;

    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      sessionFile: currentSessionFile,
      hasCfg: Boolean(cfg),
    });

    const sessionFile = currentSessionFile || undefined;

    // Read message count from hook config (default: 15)
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;

    let slug: string | null = null;
    let sessionContent: string | null = null;

    if (sessionFile) {
      // Get recent conversation content
      sessionContent = await getRecentSessionContent(sessionFile, messageCount);
      log.debug("Session content loaded", {
        length: sessionContent?.length ?? 0,
        messageCount,
      });

      // Avoid calling the model provider in unit tests, keep hooks fast and deterministic.
      if (sessionContent && cfg && !process.env.VITEST && process.env.NODE_ENV !== "test") {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        log.debug("Generated slug", { slug });
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
      slug = timeSlug.slice(0, 4); // HHMM
      log.debug("Using fallback timestamp slug", { slug });
    }

    // Format time as HH:MM:SS UTC
    const timeStr = now.toISOString().split("T")[1].split(".")[0];

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const source = (context.commandSource as string) || "unknown";

    // Build memory entry payload for Rice State commit
    const entryParts = [
      `Session snapshot: ${dateStr} ${timeStr} UTC`,
      "",
      `Session key: ${event.sessionKey}`,
      `Session id: ${sessionId}`,
      `Source: ${source}`,
      `Slug: ${slug}`,
      "",
    ];

    // Include conversation content if available
    if (sessionContent) {
      entryParts.push("Conversation summary:", sessionContent, "");
    }

    const entry = entryParts.join("\n").trim();
    const riceRunId = cfg?.memory?.rice?.runId?.trim() || event.sessionKey || agentId || "main";

    // Keep endpoint override behavior consistent with RiceMemoryManager.
    const riceEndpoint = cfg?.memory?.rice?.endpoint?.trim();
    if (riceEndpoint) {
      process.env.STORAGE_INSTANCE_URL = riceEndpoint;
      process.env.STATE_INSTANCE_URL = riceEndpoint;
    }

    const riceConfigPath = await ensureRiceSdkConfigPath();
    const client = new Client({ configPath: riceConfigPath, runId: riceRunId });
    await client.connect();
    await client.state.commit(entry, "Session context captured via session-memory hook", {
      action: "session_memory",
      reasoning: "Persist recent session context when /new is issued",
      agent_id: agentId || "main",
    });

    log.info(`Session context committed to Rice state (runId=${riceRunId})`);
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
  }
};

export default saveSessionToMemory;
