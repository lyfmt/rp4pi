# OpenViking Development Reference

## Core Rule

Treat OpenViking as an eventual long-term memory service, not a deterministic RP state store.

For API or server behavior that may vary by OpenViking version, first use the OpenViking/OV skill package if it is available in the environment. If no OV skill package is installed, inspect the local OpenViking package source or OpenAPI schema before changing code.

## Project Contract

- SQLite/state is authoritative for current RP state.
- OV only receives successful turns after writer prose is committed.
- Submit only player input and writer prose to OV.
- GM reads OV through tools; GM must not write OV directly.
- Each save uses an isolated OV user space: `save-<saveId>`.
- Session id is a queue/archive binding, not the isolation boundary.

## Known OV API Facts

- Create session supports `memory_policy`.
- Commit supports `keep_recent_count` and returns a `task_id`.
- Commit does not support `wait`; do not send it.
- Phase 1 archives synchronously; Phase 2 extracts memory in a background task.
- Real validation must poll `/api/v1/tasks/{task_id}` or list tasks by `resource_id`.

## Required OV Configuration

Default server config path:

```text
~/.openviking/ov.conf
```

The RP agent reads connection parameters from `.pi/agent/settings.json` or environment variables. The OV server itself reads memory schema configuration from `~/.openviking/ov.conf`, so changing `.pi/agent/settings.json` is not enough to load custom memory types.

| Item | Location | Required for | Fallback |
| --- | --- | --- | --- |
| `server.host` / `server.port` | `~/.openviking/ov.conf` | OV listen address. Defaults are usually `127.0.0.1:1933`. | Yes. Project connection defaults to `http://127.0.0.1:1933`. |
| `storage.workspace` | `~/.openviking/ov.conf` | OV file/session/task storage. | OV has its own default, but project does not control it. |
| `embedding.dense` | `~/.openviking/ov.conf` | Search/vector indexing for memories. | No project fallback. Broken embedding can make memory search unusable. |
| `vlm` | `~/.openviking/ov.conf` | Session memory extraction LLM. | No project fallback. Broken VLM can make extraction fail or produce no memory. |
| `memory.custom_templates_dir` | `~/.openviking/ov.conf` | Custom RP memory types: `characters`, `story_events`. | Yes. If missing, runtime falls back to built-in `entities`, `events`. |
| `openViking.url` | `.pi/agent/settings.json` | Project client connection URL. | Yes. Defaults to `http://127.0.0.1:1933`. |
| `openViking.apiKey` | `.pi/agent/settings.json` | Project client auth header. | Yes. Defaults to empty string for dev-mode OV. |
| `openViking.account` | `.pi/agent/settings.json` | Project account scope header. | Yes. Defaults to empty string for dev-mode OV. |

Expected custom schema config:

```json
{
  "memory": {
    "custom_templates_dir": "/absolute/path/to/project/worlds/<active-world>/memory"
  }
}
```

Memory schemas live inside each world pack (`worlds/<name>/memory/`), declared by
that world's `memory.schemas`. See [world-pack.md](./world-pack.md). Point
`custom_templates_dir` at the active world's memory directory.

Restart `openviking-server` after changing `~/.openviking/ov.conf`. Existing OV processes do not reload this file automatically.

## Memory Policy

Preferred RP policy:

```ts
{
  self: { enabled: true },
  peer: { enabled: false },
  memory_types: ["characters", "story_events"]
}
```

If OV rejects it with `Unknown memory_policy.memory_types`, the server has not loaded project custom schemas. Fall back to built-in types:

```ts
{
  self: { enabled: true },
  peer: { enabled: false },
  memory_types: ["entities", "events"]
}
```

When falling back, create a new OV session binding for the save before appending messages. Do not reuse a session that failed creation with an unsupported policy.

## Custom Schema Requirements

Project schema files live inside each world pack, e.g. `worlds/border-station/memory/`.

Use the OV 0.4.x memory schema shape:

- `memory_type`
- `directory`
- `filename_template`
- `enabled`
- `operation_mode`
- `fields` as an array of objects with `name`, `type`, `description`, optional `merge_op`

Do not use the older shorthand shape with `name`, `path`, and a field map unless the active OV version explicitly supports it.

To use custom types in a live OV server, its `ov.conf` must include a memory custom templates directory that points to this project schema directory, then the server must be restarted:

```json
{
  "memory": {
    "custom_templates_dir": "/absolute/path/to/project/worlds/<active-world>/memory"
  }
}
```

## Debugging Checklist

1. Confirm the client creates the session with `memory_policy`.
2. Confirm the commit body contains only supported fields.
3. Confirm commit returns `task_id`.
4. Poll the task until `completed` or `failed`.
5. Inspect `task.result.memories_extracted`.
6. If it is empty, inspect session `.meta.json` and task JSON under OV storage.
7. If custom types are unknown, verify OV server config and schema load, or test built-in `entities/events`.

Passing `accepted` is not enough. A smoke test that does not inspect the background task is a false positive.

## Verification Commands

Run project checks:

```bash
npm run typecheck
npm test
```

Validate schema parsing against local OV:

```bash
export OPENVIKING_PYTHON="/absolute/path/to/openviking/python"
"$OPENVIKING_PYTHON" - <<'PY'
from openviking.session.memory.memory_type_registry import MemoryTypeRegistry
registry = MemoryTypeRegistry(load_schemas=False)
# Replace with the active world's memory schema directory.
loaded = registry.load_from_directory('worlds/border-station/memory')
print({'loaded': loaded, 'names': registry.list_names(include_disabled=True)})
assert registry.get('characters')
assert registry.get('story_events')
PY
```

Run live validation only when a real OV server is reachable:

```bash
bash scripts/smoke-demo.sh
```

If OV is unreachable, the smoke must print `SKIP live OpenViking smoke` and exit 0.
If OV is reachable, the smoke must reach `PASS OpenViking append+commit memory smoke`.
