---
summary: "How OpenClaw memory works with Rice State and Rice Storage"
read_when:
  - You want to configure durable memory
  - You want to debug memory search or memory store behavior
---

# Memory

OpenClaw uses **Rice** for durable memory.

- **Rice State** stores durable facts and session-level memory commits.
- **Rice Storage** provides semantic retrieval for memory search.
- Workspace files like `MEMORY.md` and `memory/*.md` are optional notes, not the durable memory backend.

## Memory tools

OpenClaw exposes three memory tools:

- `memory_search`
  - Semantic recall across Rice State + Storage.
  - Returns snippets with path and line metadata.
- `memory_get`
  - Reads text only from paths returned by `memory_search`.
  - Prevents arbitrary file reads outside recall results.
- `memory_store`
  - Writes durable memory to Rice State.
  - Use for preferences, decisions, and long-lived facts.

## Config

Memory config lives under `memory` in `openclaw.json`.

```json5
{
  memory: {
    backend: "rice",
    citations: "auto", // auto | on | off
    rice: {
      enabled: true,
      endpoint: "host:port", // optional; sets both STATE_INSTANCE_URL and STORAGE_INSTANCE_URL
      runId: "agent-memory-main", // optional
      sync: {
        enabled: true,
        interval: "1m",
      },
    },
  },
}
```

Notes:

- `backend` is `rice`.
- `citations` controls whether snippet sources are included in memory snippets.
- `rice.endpoint` is an OpenClaw convenience override for both Rice services.
- `rice.runId` sets the default State run context.

## Environment variables

Rice SDK auth and endpoints are read from environment variables:

- `STATE_INSTANCE_URL`
- `STATE_AUTH_TOKEN`
- `STATE_RUN_ID` (optional)
- `STORAGE_INSTANCE_URL`
- `STORAGE_AUTH_TOKEN`
- `STORAGE_USER` (optional; default `admin`)
- `STORAGE_HTTP_PORT` (optional)

You can define these in `.env`.

## Runtime behavior

- OpenClaw initializes Rice through `rice-node-sdk`.
- OpenClaw now provides an internal generated Rice SDK config path, so a workspace `rice.config.js` file is not required.
- `session-memory` hook commits session snapshots to Rice State on `/new`.
- Memory sync is remote-aware; there is no local Markdown indexing pipeline for durable memory.

## Validation

Check memory provider status:

```bash
pnpm openclaw status --deep
```

Look for:

- `Memory: rice-node-sdk`
- `model state+storage`

Quick functional check in chat:

1. Ask the agent to store a fact with `memory_store`.
2. Ask a follow-up that should trigger `memory_search`.
3. Confirm retrieval references Rice-backed snippets.

## Troubleshooting

- Error: `gateway closed (1006 ...)`
  - Gateway is not running or wrong profile/port is targeted.
- Error: `getaddrinfo ENOTFOUND ...`
  - DNS or endpoint resolution issue for Rice host.
- Error: auth/token mismatch
  - Verify gateway auth token and remote token profile settings.
- Memory disabled in tool output
  - Confirm Rice env vars and `memory.rice.enabled` config.

## Related docs

- [Agent workspace](/concepts/agent-workspace)
- [Configuration](/configuration)
