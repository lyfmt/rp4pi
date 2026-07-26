# Module Guide

## World Manifest

`world.yaml` is the entry point. Keep it as metadata plus module paths:

```yaml
name: my-world
display_name: 我的世界
description: 一句话简介。
state: ./state.yaml
prompts: ./prompts.yaml
memory: ./memory.yaml
lore: ./lore.yaml
tools: ./tools.yaml
subagents: ./subagents.yaml
hooks: ./hooks.yaml
writing: ./writing.yaml
revision: ./revision.yaml
systems: []
```

`systems` is a direct list of module paths (see Systems below); every other
module key points at a YAML file. Do not add runtime secrets or
environment-specific connection settings here.

## State

`state.yaml` has fixed core plus optional attributes.

Fixed core:

```text
player.name
player.status
player.location
time.day
time.hour
scene.summary
```

Attributes are for simple values with local validation:

```yaml
attributes:
  vigor:
    type: int
    min: 0
    max: 100
    initial: 80
    description: 玩家体力。剧烈行动、受伤或缺乏休息时下降。
```

Use attributes for simple public state. Do not use attributes as a dumping ground for inventory ledgers, private secrets, or formulas.

Current save facts and relationships are state, not lore. They remain readable
through `get_status`, but this baseline has no general GM-facing write path for
them. Treat that as an implementation gap, not a prompt convention.

## Systems

Complex mechanics — combat, economy, inventory, progression, quests — have a
project-native home: world-local System modules.

```yaml
systems:
  - ./systems/progression.ts
```

`systems` in `world.yaml` is a direct list of module paths (unlike `state:` /
`tools:` it is not expanded as a YAML module). Each file exports one or more
`defineSystem()` results declaring save-scoped state, a version, commands, and
a projection. System modules register no Pi tools and never touch SQLite; the
scaffold persists their state per `(save, system)`.

GM advances System state only through `commit_turn` operations:

```json
{
  "operations": [
    { "system": "progression", "command": "gain_xp", "input": { "amount": 25 } }
  ]
}
```

`commit_turn` only advances state and may run multiple times within a turn.
Core player/time/scene/attributes changes still go through `update_*`, and the
presentation handoff still goes through `submit_direction_packet` separately.

Use a System module when a rule must validate transitions, apply formulas, or
persist per save. Do not encode such rules in prompt prose and do not overload
`attributes` with them. Full contract, worked example, and boundary rules:
development-guide `references/world-pack.md` "Systems".

## Prompts

`prompts.yaml` lists GM prompt files. Keep files task-focused:

- core premise and GM role;
- GM's referee/director stance and knowledge limits;
- world facts that must be seen every turn;
- tool discipline;
- output constraints.

Large stable lore belongs in `lore.yaml` and `lore/*.yaml`, then GM and writer query it with `lookup/read_lore`. Current state belongs in `get_status` and runtime state projection, not static prompt prose.

Use `prompt_template` only when the default GM/writer message order is insufficient.

GM prompt text should tell the GM how to adjudicate and hand off, not ask it to
become the writer. Good GM prompts define what the GM may decide, when it must
delegate a named role, what facts it must verify, which supported fields require
an `update_*` call, and what belongs in the direction packet. Avoid asking the
GM to perform final prose, narrate hidden interiors, or speak as a role subagent
when a role exists.

## Lore

`lore.yaml` declares fixed world-canon sources. Source files stay in the world pack and are imported into the SQLite lore index at startup:

```yaml
version: 1
sources:
  - path: ./lore/characters.yaml
    default_kind: character
  - path: ./lore/locations.yaml
    default_kind: location
  - path: ./lore/rules.yaml
    default_kind: rule
```

Lore entries may be a YAML array or `{ entries: [...] }`:

```yaml
- id: character.han-yue
  name: 韩越
  aliases: [受伤信使]
  summary: 携带密信抵达北门驿站的边关信使。
  body: 他失血未止，但仍坚持把密信送到可信之人手中。
  tags: [信使, 密信]
  visibility: public
  fields:
    faction: 边军驿传
  relations:
    - { type: located_at, target: location.border-relay }
```

Use lore for fixed people, locations, rules, items, factions, levels, abilities, and other canon that does not change per save. Use state for current facts and relationships. Use OpenViking memory for past events from the current save.

## Tools

`tools.yaml` controls GM-visible tools:

```yaml
include:
  - core.state
  - core.memory
  - core.lookup
extra: []
```

`core.state` gives `get_status`, narrow state update tools, and
`submit_direction_packet` as the presentation handoff. `core.memory` gives
OpenViking lookup tools when available. `core.lookup` gives fixed-lore
`lookup/read_lore`.

World-local tools need source implementation and tests. A tool description should say:

```text
one-line purpose
usage boundary
misuse boundary
```

Avoid long "must/forbidden" checklists in tool descriptions; they slow model action and invite rule recitation.

## Memory

`memory.yaml` declares OpenViking policy and schema files. OV is for eventual long-term recall, not authoritative current state.

Use memory for:

- recurring character facts;
- successfully delivered story events;
- revealed facts that should be searchable later.

Do not rely on memory for:

- fixed world canon;
- current time/location;
- active scene status;
- numeric meters;
- hidden truth that has not been revealed.

Custom schemas require OV server config:

```json
{
  "memory": {
    "custom_templates_dir": "/absolute/path/to/project/worlds/<active-world>/memory"
  }
}
```

Restart OV after changing that config.

## Subagents

Two kinds exist:

| Kind | Use |
|---|---|
| `role` | persistent named character voice with self trajectory |
| `tool` | one-off helper with narrow tools, such as NPC generation |

Role agents need only name, description, and prompt. The scaffold injects `recall_self` and `remember_action`.

Tool agents need explicit tools and often an extension:

```yaml
- name: role-forger
  kind: tool
  description: 依据线索铸造一个全新的可长期扮演的具名角色。
  tools: [ forge_role ]
  prompt: ./subagents/role-forger/agent.md
  extension: ./subagents/role-forger/index.ts
```

Use subagents for cognition isolation and continuity. Do not use them for calculations or direct state writes.

Subagents run as fresh child processes that do not load the main process's
extensions, so GM-surface tools (`lookup`, `read_lore`, `get_status`, memory
tools) do not exist there — listing them in `tools` does nothing, because
unknown names in the allowlist are ignored. A subagent's `tools` can only
enable pi built-ins plus tools registered by that subagent's own `extension`
(role agents additionally get the injected `recall_self` / `remember_action`).
When a research/director agent needs fixed canon, either put the relevant
canon into its task brief, or ship a world-local child extension exposing a
narrow lookup tool (the border-station `npc-generator` extension is the
pattern). Do not put secret lore into a role agent's brief unless that
character should know it.

Role prompts are character documents, not analyst briefs. Write them as:

- identity: "You are X", not "describe X";
- first-person action and speech only;
- known/unknown boundaries from that character's perspective;
- desires, fears, loyalties, habits, and wounds that shape choices;
- hard refusal to decide GM outcomes, act for the player, reveal unknowable facts, or narrate other minds.

If a role needs to output structured candidates, make it a `tool` subagent instead of weakening the role boundary.

## Hooks

Hooks attach world behavior to lifecycle anchors:

| Anchor | Meaning |
|---|---|
| `session_start` | first turn after new/load session |
| `turn_start` | before GM loop starts |
| `turn_committed` | after prose is committed |

Actions:

| Action | Use |
|---|---|
| `inject` | prompt or player-visible notice |
| `state` | simple deterministic mutation |
| `delegate` | inject an instruction for GM to delegate later |

Use hooks for drift, background beats, notices, and simple state changes. Do not put complex game systems into hook YAML.

## Writing

`writing.yaml` is a directory of writing guides. Writer sees only kind and description until it calls `read_writing_guide`.

Writer is read-only. Its allowed project tools are `get_status`, `lookup/read_lore`, `read_writing_guide`, and `search_memory/read_memory` when OV is available. It must not update state or submit turns.

Writing guides are page-level craft guidance. They should define how the
submitted scene becomes prose: POV, distance from the player character, sensory
anchors, pacing, dialogue texture, genre pressure, and what the prose must
withhold. They should not define mechanics, decide success/failure, or invent
new character actions.

`characterActions` from the direction packet are authoritative for named NPCs. The writer may turn an action into lived dialogue and gesture, but must not contradict it, add hidden motives as fact, or give lines to a role that did not act unless the packet leaves that room.

Good kinds:

```text
style
dialogue
combat-prose
romance
adult
```

Keep guides specific and actionable. Do not describe app features or tool mechanics inside player-facing prose guidance.

## Revision

`revision.yaml` configures final prose review, especially banned cliches:

```yaml
banned_words:
  - 忽然
  - 顿时
  - 仿佛时间静止
```

Use it for repeated prose failures. Do not use it for mechanical rules.

## Start Skill

`skills/start-game/SKILL.md` is currently project-level. If a new world needs custom setup, update it so it is world-aware or create a world-specific start flow and ensure the active GM can find it.

Opening setup should ask for missing player fields in one round, provide defaults, then enter the scene.

## Runtime Source

Only change `src/` when module configuration cannot express the behavior. Common source work:

- new world-local tool support;
- stricter state schema or migration;
- private hidden state/reveal ledger;
- combat/economy/inventory/quest capabilities the System module contract cannot express (world-local System modules are the first home — see Systems);
- prompt template markers;
- additional writer/revision behavior.

Use `development-guide` when touching source.
