# Project Mapping

## Target Shape

This repository's primary authoring unit is a world pack:

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

`migration/` is for audit artifacts. Runtime-facing modules should be clean project-native files.

## IR To Module Map

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
| complex mechanics (affinity/HP/economy/combat rules) | world-local System module: `worlds/<slug>/systems/*.ts` with `defineSystem()`, listed in `world.yaml` `systems:`; GM advances it via `commit_turn` operations (see `development-guide` world-pack "Systems"). Only fall back to a `src/` implementation plan when a capability the System contract lacks is required |

## Prompt Mapping

Keep GM prompt modular:

- `prompts/gm-core.md`: premise, role, visibility rules, scene protocol.
- `prompts/gm-tools.md`: when to use state, memory, and subagent tools.
- `prompts/gm-output.md`: short output contract if the world needs one.
- `prompt_template` only when default GM/writer ordering is insufficient.

Do not put large worldbook dumps, status panels, or formulas into prompt files. Large fixed facts need lore YAML plus built-in `lookup/read_lore`; formulas need runtime implementation.

## State Mapping

Use fixed core for:

```text
player.name
player.status
player.location
time.day
time.hour
scene.summary
```

Use `attributes` for simple world-specific values:

```yaml
attributes:
  suspicion:
    type: int
    min: 0
    max: 100
    initial: 10
    description: Publicly safe description of what the value means.
```

Do not store hidden truth in public attributes unless this scaffold has a private projection for it. Prefer a private prompt/subagent boundary or an implementation plan.

## Memory Mapping

OpenViking is long-term recall, not current-state authority.

- Characters and story events belong in memory schemas.
- Current location, time, active objective, and simple meters belong in SQLite state.
- Hidden-canonical memory must not use public `characters` or `story_events` unless it has been revealed.
- Schema changes require `~/.openviking/ov.conf` to point `memory.custom_templates_dir` at the active world's `memory/` directory.

## Subagent Mapping

Use subagents for cognition boundaries, not for arithmetic or generic quality.

| Need | Form |
|---|---|
| Persistent named NPC voice | `kind: role` |
| Generate and remember a new NPC | `kind: tool` with a world-local extension (`forge_character` is a border-station example, not a base tool — each world declares its own in `subagents.yaml`; loader defers extension validation, so a missing module only fails at GM delegation time) |
| Create a new persistent role during play | `kind: tool` with base-platform `forge_role` |
| Secret/faction perspective | role or tool subagent with filtered task context |
| Combat/economy/rules calculation | not subagent; System module (`defineSystem` + `commit_turn`) or world-local tools |

Subagent output is input to GM. GM still owns deterministic state changes
through the existing `update_*` tools and owns direction packets through
`submit_direction_packet`. General facts/relationships writes remain an
implementation gap until the extension contract is redesigned.

## Validation

Run structural checks:

```bash
npm run typecheck
npm test
```

Run ST residue scans:

```bash
rg -n "UpdateVariable|JSON Patch|<%_|__结束__|强化思考要求" \
  worlds/<slug> data skills/start-game --glob '!worlds/<slug>/migration/**'
rg -n "\\{\\{(user|char|random|roll|pick|getvar|setvar)" \
  worlds/<slug> data skills/start-game --glob '!worlds/<slug>/migration/**'
```

Expected runtime-facing result: no hits outside migration notes.

If the world has live behavior, run:

```bash
RP_WORLD=<slug> bash scripts/smoke-demo.sh
```

If a complex mechanic was only written in prompt text, the migration is incomplete.
