# OpenViking Investigation Notes

This note records observed OpenViking usage from `../template/OpenViking`.
It is not yet the RP scaffold integration design.

## Deployment And Client Modes

OpenViking supports two practical integration modes:

- Embedded Python SDK:
  - `openviking.OpenViking(path="./data")`
  - `openviking.SyncOpenViking`
  - `openviking.AsyncOpenViking`
- Remote HTTP server:
  - `openviking-server`
  - default server port: `1933`
  - OpenClaw plugin uses remote HTTP mode.

For a TypeScript pi scaffold, the OpenClaw plugin is the closest reference. It
implements its own TS `OpenVikingClient` over HTTP.

## Server Setup

OpenViking server is configured with `ov.conf`.

Important defaults from the example config:

- server: `0.0.0.0:1933`
- storage workspace: `./data`
- memory extraction: enabled
- memory version: `v2`
- auto L0/L1 generation: enabled
- default search mode: `thinking`
- default search limit: `3`

The server needs embedding and VLM configuration. It can use providers such as
Volcengine, OpenAI-compatible services, Codex OAuth, Kimi, GLM, or Ollama.

## Core HTTP APIs Used By OpenClaw

OpenClaw's TS client uses these endpoints:

```text
GET  /health
POST /api/v1/sessions
GET  /api/v1/sessions/{session_id}
POST /api/v1/sessions/{session_id}/messages
POST /api/v1/sessions/{session_id}/commit
GET  /api/v1/sessions/{session_id}/context
GET  /api/v1/sessions/{session_id}/archives/{archive_id}
GET  /api/v1/tasks/{task_id}
POST /api/v1/search/find
GET  /api/v1/content/read?uri=...
POST /api/v1/content/write
GET  /api/v1/fs/ls?uri=...
POST /api/v1/resources
POST /api/v1/skills
DELETE /api/v1/fs?uri=...
```

Request headers used by OpenClaw:

```text
X-API-Key
X-OpenViking-Account
X-OpenViking-User
X-OpenViking-Actor-Peer
```

`X-OpenViking-Actor-Peer` controls actor/peer scoped memory visibility.

## Session Lifecycle Model

OpenViking sessions are stored under user session space, for example:

```text
viking://user/sessions/<session_id>
```

Observed flow:

1. Create or ensure a session.
2. Append messages with `POST /sessions/{id}/messages`.
3. Commit the session with `POST /sessions/{id}/commit`.
4. Commit archives live messages and starts memory extraction.
5. `wait=false` returns quickly with a background `task_id`.
6. `wait=true` polls until phase 2 extraction completes or times out.
7. `keep_recent_count` can keep the newest messages live after commit.
8. `GET /sessions/{id}/context` returns:
   - `latest_archive_overview`
   - `pre_archive_abstracts`
   - active messages
   - token statistics

OpenClaw uses this for:

- after-turn capture;
- threshold-triggered async commit;
- explicit compact with blocking commit;
- context assembly from archive summary plus active messages.

## Memory Write Paths

There are two confirmed write paths.

### 1. Session Commit Extraction

OpenClaw's `memory_store` tool writes text as an OpenViking session message and
then calls `commitSession(wait=true)`.

This lets OpenViking's memory extractor decide what long-term memory files to
create.

Observed `memory_store` behavior:

```text
addSessionMessage(sessionId, role, [{ type: "text", text }])
commitSession(sessionId, { wait: true, keepRecentCount: 0 })
```

If no session id is provided, OpenClaw may create a temporary session for the
explicit memory write.

### 2. Direct Memory File Write

OpenViking also supports direct text writes:

```text
POST /api/v1/content/write
```

The target can be a memory URI such as:

```text
viking://user/<user>/memories/preferences/theme.md
viking://user/<user>/memories/entities/name.md
viking://user/<user>/memories/events/2026/06/11/event.md
```

Tests show direct writes to memory files:

- preserve memory metadata on replace/append;
- refresh vector status;
- update parent `.overview.md`;
- classify result context as `memory`;
- can link resource references from Markdown links or bare resource URIs.

This path is more deterministic, but bypasses the session memory extractor's
judgment.

## Memory Read / Recall

OpenClaw exposes `memory_recall`.

Observed recall flow:

1. Build search plan.
2. Call `POST /api/v1/search/find`.
3. Usually search `context_type: "memory"` for user/agent memory.
4. Optionally search `context_type: "resource"` for imported resources.
5. Filter to leaf memory entries where possible.
6. Rerank/post-process.
7. Read full entries with `GET /api/v1/content/read`.
8. Return complete memory lines under a character budget.

Default target URI from OpenClaw config:

```text
viking://user/memories
```

Default recall target types:

```text
user, agent
```

## URI And Identity Notes

Memory URI patterns include:

```text
viking://user/.../memories/...
viking://agent/.../memories/...
```

OpenClaw maps unsafe runtime session ids to safe OpenViking session ids:

- UUID session ids are reused.
- Unsafe ids or session keys are hashed with SHA-256.

OpenClaw also sanitizes actor peer ids to `[a-zA-Z0-9_-]` before sending them as
`X-OpenViking-Actor-Peer`.

## Confirmed RP MVP Decisions

- The MVP uses real OpenViking as the long-term memory layer.
- SQLite/state remains the deterministic state layer. OpenViking is only the
  eventually consistent semantic memory layer.
- GM does not write OpenViking memories directly.
- Turn-end memory write is automatic in a hook after writer prose succeeds and
  state is persisted.
- Only player input and writer prose are appended to the OpenViking session:
  - player input as `user`;
  - writer prose as `assistant`.
- Direction packets, GM tool calls, SQLite state diffs, internal retries, and
  failed turns are not submitted to OpenViking.
- Each save gets a dedicated OpenViking user space:

```text
viking://user/save-{uuid}/memories
```

- Each save also has one long-lived OpenViking session, used as an append/commit
  queue rather than as the isolation boundary.
- Commit uses `keep_recent_count=0`.
- Commit uses async Phase 2 (`wait=false`). The returned `task_id` is logged but
  not persisted to SQLite.
- GM can read OpenViking through:
  - `search_memory(query, limit?)`;
  - `read_memory(uri)`.
- GM does not get `write_memory`, `commit_turn_memory`, `delete_memory`, or
  `list_memory`.
- No automatic memory recall is injected into GM context. GM decides when to
  search/read.
- MVP custom memory schemas:
  - `characters`;
  - `story_events`.
- Default long-term memory schemas such as `profile`, `preferences`,
  `entities`, and `events` should be disabled for the RP MVP extraction policy.

See `docs/design/openviking-mvp.md` for the full integration design.

## Relevant Lessons For RP Scaffold

- TypeScript integration should likely use HTTP mode, not embedded Python SDK.
- The scaffold should not implement vector or L0/L1 logic itself if OV is the
  MVP memory backend.
- The MVP uses automatic/session extraction from captured successful RP turns.
- Deterministic direct writes are intentionally not part of the MVP because
  SQLite/state owns deterministic correction.
- OpenViking session context assembly is powerful, but may conflict with the RP
  decision that writer prose is not injected into GM context.
- Explicit `memory_recall` as a GM tool maps cleanly to OV.
- Explicit `memory_store` as a GM tool is not used in the MVP.
- Auto-recall before every GM reply is not used in the MVP.
