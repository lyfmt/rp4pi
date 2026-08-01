# Build Flow

## 1. Inspect Current Shape

Read these first:

```bash
cat README.md
cat skills/development-guide/references/world-pack.md
find worlds/_template -maxdepth 3 -type f | sort
```

Use `worlds/border-station/` as the living example when a module is unclear.

## 2. Decide Scope

Create a short RP contract, then map it to modules:

| Question | Output |
|---|---|
| What is the player doing every turn? | core loop |
| Who is the GM in this world? | adjudication stance and limits |
| What should the writer feel like on the page? | camera, POV, rhythm, style guides |
| What must persist across turns? | state/memory list |
| What must remain hidden? | visibility handling |
| Which NPCs need continuity? | role subagents with first-person identity, knowledge, and refusal boundaries |
| What changes automatically? | hooks |
| Which facts are fixed world canon? | `lore.yaml` and `lore/*.yaml` source list |
| Which facts need custom mechanics or retrieval beyond built-in lookup? | implementation gaps |

If the answer contains complex mechanics, hidden reveal guarantees, or strict cross-agent visibility rules, put them under "implementation gaps" and do not pretend prompt text or `world.yaml` can solve them.

## 3. Create A World Pack

```bash
cp -r worlds/_template worlds/<slug>
```

Then update:

```text
worlds/<slug>/world.yaml
worlds/<slug>/state.yaml
worlds/<slug>/lore.yaml
worlds/<slug>/lore/*.yaml
worlds/<slug>/prompts.yaml
worlds/<slug>/prompts/*.md
worlds/<slug>/memory.yaml
worlds/<slug>/memory/*.yaml
worlds/<slug>/tools.yaml
worlds/<slug>/subagents.yaml
worlds/<slug>/hooks.yaml
worlds/<slug>/writing.yaml
worlds/<slug>/writing/*.md
worlds/<slug>/revision.yaml
```

Keep `_template` untouched except when deliberately improving the template for all future worlds.

## 4. Fill In This Order

1. `world.yaml`: name, display name, description, module paths.
2. `state.yaml`: opening state and simple attributes.
3. `lore.yaml` and `lore/*.yaml`: fixed world canon queried by `lookup/read_lore`.
4. `prompts/`: GM identity, adjudication stance, setting, tool discipline, output contract.
5. `memory.yaml` and `memory/*.yaml`: what OV should extract after committed prose.
6. `writing.yaml` and `writing/*.md`: prose camera, style, dialogue, and role-play texture read by writer on demand.
7. `revision.yaml`: banned words/cliches.
8. `subagents.yaml`: persistent first-person roles and narrow tool agents.
9. `hooks.yaml`: lifecycle drift, notices, and background pressure.
10. `tools.yaml`: built-in groups and any world-local tool modules.
11. `world.yaml` `systems:` + `systems/*.ts`: world-local System modules, only when the world needs complex mechanics (see module-guide "Systems").

## 5. Runtime Loop Checklist

Each playable turn should preserve this chain:

```text
player input
-> GM reads current state with get_status when needed
-> GM queries fixed lore with lookup/read_lore when needed
-> GM queries save history with search_memory/read_memory when needed
-> GM calls tools for mechanical facts or local corrections
-> GM delegates role subagents when named NPCs need to act
-> GM applies Core player/time/scene/attributes changes through existing update_* tools
-> GM applies System module state changes through commit_turn operations as needed
-> GM uses submit_direction_packet for the direction packet or direct reply
-> writer reads packet, prior prose, status, lore, memory, and writing guides
-> revision pipeline reviews/rewrite prose
-> successful rendered prose records a story snapshot
-> OpenViking and hooks run after successful story delivery
```

`submit_direction_packet` is the only presentation handoff and never writes state.
The current `update_*` tools cover Core fields and declared attributes. Registered
System module commands are invoked through `commit_turn`, which only advances state
and may run multiple times before presentation handoff. Do not let writer write state.
Do not let subagents write state except through
explicitly scoped tool agents whose output GM still adjudicates.

Authorship notes:

- GM direction tells the writer what changed and what each actor intends; it does not perform the final prose or speak as role subagents.
- Writer renders the playable text; it does not invent new rulings, new facts, or secret knowledge to make the scene stronger.
- Role subagents speak and act only as themselves; they do not summarize the world, report on other minds, or exceed what the character can know.
- Tool agents return candidates or facts inside their brief; GM remains the adjudicator.
