# RP Agent Scaffold MVP - Non-Memory Design

This document records the confirmed MVP decisions that do not depend on the
memory backend. Memory is intentionally excluded because the MVP direction has
changed to use OpenViking and needs a separate design pass.

## Goal

Build a reusable pi-based role-play project scaffold, not a full framework.

The generated project must run a complete minimal demo flow:

1. Player sends input.
2. GM adjudicates and reads or updates current world state through tools.
3. GM submits a direction packet independently from state updates.
4. Writer renders player-visible prose.
5. Runtime displays prose as a custom message.
6. Runtime records a story snapshot after successful prose delivery.

## Project Shape

- Deliver a copyable template directory first, not a CLI generator.
- Use TypeScript.
- Follow the pi extension style used by the reference projects.
- Use pi TUI as the only player-facing UI for MVP.
- Provide `skills/start-game/SKILL.md` as the start entry.
- Use a fixed demo world for MVP; no world-template picker.

## Agents

### GM

- GM is the main interactive agent.
- GM prompt files live under `agents/*.md`.
- The extension injects GM prompt files into context.
- GM does not write player-visible prose directly when a rendered turn is
  required.
- GM must update mutable world state only through tools.

### Writer

- Writer is a separate real pi agent/preset.
- Writer prompt lives at `.pi/agents/writer.md`.
- MVP writer uses a fixed neutral novel style.
- Later versions may add writer style tools, but MVP does not implement that.
- Writer cannot mutate state.

## Direction Packet And State Updates

GM applies deterministic state changes through the existing narrow `update_*`
tools, then finishes a renderable turn by passing this direction packet to
`submit_direction_packet`:

```json
{
  "storyElements": {
    "currentSituation": "",
    "playerIntent": "",
    "visibleChanges": [],
    "presentCharacters": [],
    "tension": ""
  },
  "needsRender": true,
  "directReply": ""
}
```

Rules:

- `needsRender=true`: call writer and display writer prose.
- `needsRender=false`: do not call writer; display `directReply`.
- `storyElements` is the GM's current story-element handoff to writer, not
  player-visible prose and not a prose summary.
- Writer receives the current story elements and writes the prose surface.
- `directReply` enters GM context because it is GM dialogue, not writer prose.
- `submit_direction_packet` is the only presentation handoff and does not mutate state.
- Current facts and relationships remain readable state, but their general write
  path is deferred to the next extension-capability design.

## Prose Context Rules

- Writer prose is displayed as a custom message.
- Writer prose must be filtered out of GM context by the extension context hook.
- No prose digest is injected into GM context.
- GM continuity comes from pi session plus state.
- Writer uses Pass B prose history:
  - previous custom prose is passed to writer as assistant messages;
  - previous user input and GM tool results are not passed to writer;
  - the current story elements are the final user message;
  - if prose history exceeds budget, older prose becomes mechanical story-element
    digest lines.
- Full prose layer budget: 40,000 characters.
- Digest layer budget: 20,000 characters.
- Digest lines are derived mechanically from prior direction packet
  `storyElements`, not by an LLM.

## State Model

MVP demo state contains:

```json
{
  "player": {
    "name": "",
    "status": "",
    "location": ""
  },
  "time": {
    "day": 1,
    "hour": 8
  },
  "scene": {
    "summary": ""
  }
}
```

All state changes must go through tools. Tools directly mutate hot state and
immediately persist `latest_state`.

State tools:

- `initialize_new_game`
- `get_status`
- `update_location`
- `update_player_status`
- `update_time`
- `update_scene`
- `update_attribute`
- `submit_direction_packet`

Tool boundaries:

- `initialize_new_game`: creates a new UUID save and initializes player name,
  time, location, status, and scene.
- `update_location`: only updates `player.location`.
- `update_player_status`: only updates `player.status`.
- `update_time`: supports either absolute set or relative hour advance. These
  modes are mutually exclusive.
- `update_scene`: only updates `scene.summary`.
- `update_attribute`: only updates declared world attributes.
- `submit_direction_packet`: submits the writer direction packet or a direct
  reply; it does not mutate state.
- Facts and relationships have no general GM-facing write tool in this baseline.
- Update tools support partial updates within their own narrow field boundary.

## Persistence

- Use Node 24 built-in `node:sqlite`.
- Use one SQLite file for the scaffold MVP.
- Separate saves by `save_id`, not by multiple database files.
- The current pi session is bound to an active save in SQLite.
- One save may be used by multiple pi sessions.
- `/load` changes the current pi session's save binding but does not rewrite pi
  session history.

Required logical tables:

```sql
saves(id, created_at, updated_at)
session_bindings(pi_session_id, save_id, updated_at)
latest_states(save_id, state_json, updated_at)
turn_snapshots(save_id, turn_no, state_json, created_at)
```

Rules:

- `latest_state` is the hot-state recovery copy.
- `latest_state` is written immediately after state tools mutate state.
- Successful story snapshots are written only after `needsRender=true` and
  writer prose succeeds.
- `needsRender=false` only updates `latest_state`; it is not a successful story
  turn.
- Writer failure does not create a successful story snapshot.
- Each save keeps only the latest two successful story snapshots.
- `turn_no` is scoped per save and increments only for successful story turns.

## Slash Commands

MVP slash commands:

- `/status`
- `/save`
- `/load`
- `/roll`

### `/status`

Shows only:

```text
玩家：<name>
状态：<player.status>
地点：<player.location>
时间：第 <day> 天 <hour>:00
场景：<scene.summary>
```

### `/save`

- Saves the current active save.
- Output includes the save id.
- Does not print status.

### `/load`

- Interactive save picker.
- Saves are listed by `updated_at | save_id`.
- Page size: 10 saves.
- Prefer pi native picker if available.
- If no picker API is available, fall back to a numbered two-step selection.
- After load, bind the current pi session to the selected save and load its
  `latest_state`.
- After load, print status.

### `/roll`

- Re-rolls only within the current save.
- Does not support cross-save roll.
- Loads the previous successful story snapshot for the current save.
- Uses the current pi session's latest user message.
- Re-enters the GM -> writer -> story-snapshot flow.

## Tool Layout

Follow the reference project layout:

```text
tools/
  state/
  lookup/
  debug/
  runtime/
```

`tools/state` contains narrow state-facing tools and the presentation handoff.
`tools/runtime` contains tool contracts, rendering helpers, and result types.
`tools/lookup` and `tools/debug` may be minimal or empty in MVP.
