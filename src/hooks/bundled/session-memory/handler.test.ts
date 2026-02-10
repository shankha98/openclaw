import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";

const riceMocks = vi.hoisted(() => {
  const commit = vi.fn(async () => true);
  const connect = vi.fn(async () => {});
  const Client = vi.fn(function MockRiceClient(this: Record<string, unknown>) {
    this.connect = connect;
    this.state = { commit };
  });
  return { commit, connect, Client };
});

vi.mock("rice-node-sdk", () => ({
  Client: riceMocks.Client,
}));

// Avoid calling the embedded Pi agent (global command lane); keep this unit test deterministic.
vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("simple-math"),
}));

let handler: HookHandler;

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.STORAGE_INSTANCE_URL;
  delete process.env.STATE_INSTANCE_URL;
});

/**
 * Create a mock session JSONL file with various entry types.
 */
function createMockSessionContent(
  entries: Array<{ role: string; content: string } | { type: string }>,
): string {
  return entries
    .map((entry) => {
      if ("role" in entry) {
        return JSON.stringify({
          type: "message",
          message: {
            role: entry.role,
            content: entry.content,
          },
        });
      }
      return JSON.stringify(entry);
    })
    .join("\n");
}

function latestCommittedInput(): string {
  const call = riceMocks.commit.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected commit to be called");
  }
  return String(call[0] ?? "");
}

describe("session-memory hook", () => {
  it("skips non-command events", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    expect(riceMocks.connect).not.toHaveBeenCalled();
    expect(riceMocks.commit).not.toHaveBeenCalled();
  });

  it("skips commands other than new", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");

    const event = createHookEvent("command", "help", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    expect(riceMocks.connect).not.toHaveBeenCalled();
    expect(riceMocks.commit).not.toHaveBeenCalled();
  });

  it("commits session content on /new command", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4" },
    ]);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    expect(riceMocks.connect).toHaveBeenCalledTimes(1);
    expect(riceMocks.commit).toHaveBeenCalledTimes(1);
    const payload = latestCommittedInput();
    expect(payload).toContain("Session key: agent:main:main");
    expect(payload).toContain("Session id: test-123");
    expect(payload).toContain("user: Hello there");
    expect(payload).toContain("assistant: 2+2 equals 4");
  });

  it("filters out non-message entries (tool calls, system)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello" },
      { type: "tool_use" },
      { role: "assistant", content: "World" },
      { type: "tool_result" },
      { role: "user", content: "Thanks" },
    ]);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    const payload = latestCommittedInput();
    expect(payload).toContain("user: Hello");
    expect(payload).toContain("assistant: World");
    expect(payload).toContain("user: Thanks");
    expect(payload).not.toContain("tool_use");
    expect(payload).not.toContain("tool_result");
  });

  it("filters out command messages starting with /", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "/help" },
      { role: "assistant", content: "Here is help info" },
      { role: "user", content: "Normal message" },
      { role: "user", content: "/new" },
    ]);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    const payload = latestCommittedInput();
    expect(payload).not.toContain("/help");
    expect(payload).not.toContain("/new");
    expect(payload).toContain("assistant: Here is help info");
    expect(payload).toContain("user: Normal message");
  });

  it("respects custom messages config (limits to N messages)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const entries = [];
    for (let i = 1; i <= 10; i += 1) {
      entries.push({ role: "user", content: `Message ${i}` });
    }
    const sessionContent = createMockSessionContent(entries);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true, messages: 3 },
          },
        },
      },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    const payload = latestCommittedInput();
    expect(payload).not.toContain("user: Message 1\n");
    expect(payload).not.toContain("user: Message 7\n");
    expect(payload).toContain("user: Message 8");
    expect(payload).toContain("user: Message 9");
    expect(payload).toContain("user: Message 10");
  });

  it("filters messages before slicing (fix for #2681)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const entries = [
      { role: "user", content: "First message" },
      { type: "tool_use" },
      { type: "tool_result" },
      { role: "assistant", content: "Second message" },
      { type: "tool_use" },
      { type: "tool_result" },
      { role: "user", content: "Third message" },
      { type: "tool_use" },
      { type: "tool_result" },
      { role: "assistant", content: "Fourth message" },
    ];
    const sessionContent = createMockSessionContent(entries);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true, messages: 3 },
          },
        },
      },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    const payload = latestCommittedInput();
    expect(payload).not.toContain("First message");
    expect(payload).toContain("assistant: Second message");
    expect(payload).toContain("user: Third message");
    expect(payload).toContain("assistant: Fourth message");
  });

  it("handles empty session files gracefully", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: "",
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    expect(riceMocks.commit).toHaveBeenCalledTimes(1);
    const payload = latestCommittedInput();
    expect(payload).toContain("Session key: agent:main:main");
  });

  it("uses configured Rice endpoint and runId", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "hello" }]),
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
      memory: {
        rice: {
          endpoint: "127.0.0.1:50059",
          runId: "agent-memory-main",
        },
      },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    expect(riceMocks.Client).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: expect.any(String),
        runId: "agent-memory-main",
      }),
    );
    expect(process.env.STORAGE_INSTANCE_URL).toBe("127.0.0.1:50059");
    expect(process.env.STATE_INSTANCE_URL).toBe("127.0.0.1:50059");
  });
});
