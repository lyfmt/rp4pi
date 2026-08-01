# Project Mapping

## Target Shape

This repository's primary authoring unit is a world pack. A migration may use any
subset of this shape:

```text
worlds/<slug>/
├── world.yaml
├── state.yaml
├── prompts.yaml
├── memory.yaml
├── lore.yaml
├── tools.yaml
├── subagents.yaml
├── hooks.yaml
├── writing.yaml
├── revision.yaml
├── prompts/
├── memory/
├── writing/
├── lore/
└── migration/
    ├── card-ir.json
    └── runtime-plan.md
```

`migration/` is optional and can hold any source notes or intermediate artifacts
the author wants to retain.

## Possible IR To Module Map

| IR Block | Project File |
|---|---|
| persona, settingFacts | `prompts/*.md`, `lore.yaml`, `lore/*.yaml` |
| playerSetup, openings | `state.yaml`, `skills/start-game/SKILL.md` if custom setup is needed |
| style | `writing.yaml` plus `writing/*.md` |
| cliche/style bans | `revision.yaml` |
| scene/time/player defaults | `state.yaml` fixed core |
| simple public meters | `state.yaml` attributes |
| memoryRules | `memory.yaml`, `memory/*.yaml`, OpenViking config note |
| worldbook data | `lore.yaml`, `lore/*.yaml`, queried by built-in `lookup/read_lore`; custom source work only for mechanics or retrieval beyond fixed lore |
| periodic drift/background pressure | `hooks.yaml` |
| NPC continuity | `subagents.yaml` role agents |
| new NPC/role creation | tool subagents such as `npc-generator` or `role-forger` |
| complex mechanics (affinity/HP/economy/combat rules) | world-local System module: `worlds/<slug>/systems/*.ts` with `defineSystem()`, listed in `world.yaml` `systems:` and advanced through `commit_turn`; source implementation is another available choice |

## Prompt Mapping

GM prompts can be split by responsibility:

- `prompts/gm-core.md`: premise, role, visibility rules, scene protocol.
- `prompts/gm-tools.md`: when to use state, memory, and subagent tools.
- `prompts/gm-output.md`: short output contract if the world needs one.
- `prompt_template` is available when a different GM/writer ordering is useful.

Large fixed facts often fit lore YAML plus built-in `lookup/read_lore`; formulas
can use runtime implementation when deterministic behavior matters.

## State Mapping

The fixed core provides:

```text
player.name
player.status
player.location
time.day
time.hour
scene.summary
```

`attributes` can hold simple world-specific values:

```yaml
attributes:
  suspicion:
    type: int
    min: 0
    max: 100
    initial: 10
    description: Publicly safe description of what the value means.
```

Hidden truth can use a private prompt/subagent boundary or source implementation
when public attributes are not suitable.

## Memory Mapping

OpenViking is designed for long-term recall rather than current-state authority.

- Characters and story events often fit memory schemas.
- Current location, time, active objective, and simple meters often fit SQLite state.
- Hidden-canonical memory can remain outside public `characters` or `story_events` until revealed.
- Schema changes require `~/.openviking/ov.conf` to point `memory.custom_templates_dir` at the active world's `memory/` directory.

## Subagent Mapping

Subagents are available for cognition boundaries and continuity. Arithmetic or
generic helper work can use other module choices.

| Need | Form |
|---|---|
| Persistent named NPC voice | `kind: role` |
| Generate and remember a new NPC | `kind: tool` with a world-local extension (`forge_character` is a border-station example, not a base tool; each world may declare its own in `subagents.yaml`) |
| Create a new persistent role during play | `kind: tool` with base-platform `forge_role` |
| Secret/faction perspective | role or tool subagent with filtered task context |
| Combat/economy/rules calculation | System module (`defineSystem` + `commit_turn`), world-local tools, or another chosen implementation |

Subagent output is input to GM. GM still owns deterministic state changes
through the existing `update_*` tools and owns direction packets through
`submit_direction_packet`. General facts/relationships writes remain an
implementation gap until the extension contract is redesigned.
