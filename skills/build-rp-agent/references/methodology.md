# Methodology

## Adapted Principle

Use tavern2agent's core rule in this scaffold:

```text
Prompt describes operating stance.
Lore carries fixed canon.
State, tools, hooks, memory, and subagents carry runtime facts.
```

This project does not currently expose a general event-pack engine. Therefore, complex mechanics should become implementation plans, not fake prompt rules.

Add the RP authorship rule:

```text
GM adjudicates the fiction.
Role agents inhabit characters.
Writer renders the submitted direction.
No actor authors outside its role.
```

The goal is a playable role-play scene, not a mechanical report. Prompts should sound like responsibilities at a table or in a writer's room: who knows what, who can decide what, who can speak as whom, and where the handoff ends.

## Module Decision Table

| Requirement | Preferred Home |
|---|---|
| Stable premise and GM stance | `prompts/*.md` |
| Fixed canonical lore | `lore.yaml`, `lore/*.yaml`, queried by `lookup/read_lore` |
| Opening defaults | `state.yaml` |
| Simple public meter | `state.yaml` attributes |
| Current facts and relationships | current state for reads; general writes require a new extension-capability design |
| Long-term character/event recall | `memory.yaml`, `memory/*.yaml` |
| Recurring named NPC voice | `subagents.yaml` role |
| Generate new memorable NPC | `npc-generator` or `role-forger` tool agent |
| Background drift or timed pressure | `hooks.yaml` |
| Prose style and dialogue rules | `writing.yaml`, `writing/*.md` |
| Repeated prose cliches | `revision.yaml` |
| Mechanical formula or ledger | source implementation plan |
| Hidden truth with reveal guarantees | source implementation plan or carefully isolated subagent context |

## Visibility

Separate facts before writing prompts:

| Layer | Meaning |
|---|---|
| `player-only` | real player knows; character may not |
| `protagonist-known` | player character knows |
| `scene-public` | scene actors can know |
| `hidden-canonical` | true but unrevealed |

Hidden-canonical facts do not belong in public prompts, public memory schemas, writer packets, or role agents that should not know them.

## Authorship

| Actor | Good instruction | Bad instruction |
|---|---|---|
| GM | "Resolve the player's intent, establish consequences, delegate named NPCs, update supported state fields, then submit the direction packet." | "Write a vivid scene and explain all outcomes yourself." |
| Writer | "Render only the submitted direction with this world's camera, texture, and dialogue rules." | "Improve the plot if the packet feels thin." |
| Role subagent | "You are this character; answer in first person from your memories and current knowledge." | "Analyze the scene and provide what this NPC should do." |
| Tool agent | "Return candidate facts or drafts for GM adjudication." | "Decide what becomes true in the story." |

Use this test while editing any prompt: if the text asks an actor to know, decide, or write something outside its fictional or runtime role, move that instruction to the correct module or stop and plan source work.

## Multi-Agent Rule

Use role/tool subagents only when they buy one of these:

- continuity of a named character's speech and action;
- secret or faction perspective isolation;
- bounded helper work such as forging a persistent role;
- audit/candidate output that GM will adjudicate.

Do not split because a scene is "important" or because the GM should be smarter. If a TypeScript function can settle it, use code.

## Writer Rule

Writer is read-only. It receives direction packets and renders prose. It may read writing guides, status, fixed lore, and memory. It must not update state, invent mechanical results, or override role-subagent character actions.

GM applies supported deterministic state changes through the existing `update_*`
tools before presentation handoff. `submit_direction_packet` then carries only
the authoritative player action, resolved visible changes, scene direction,
and `characterActions` for named NPCs that acted this turn. Facts and
relationships do not gain a prompt-only write path while their replacement API
is still undesigned.

Writer guidance should define a camera, not a control panel: POV, sensory density, prose rhythm, dialogue texture, taboo cliches, and knowledge limits. It should not explain app internals, tool protocols, or future plot logic unless those affect what appears on the page.

## Prompt Discipline

Keep prompt modules short and operational:

- describe what the GM should see every turn;
- tell the GM which tool boundary exists;
- write the GM as a referee/director, not as the final prose author;
- avoid long checklists and self-descriptions;
- avoid repeated examples of banned prose;
- keep final output contracts short.

If a rule must be reliable after context compaction, move it into lore, state, hook, tool, memory, or tests.

## Validation Mindset

`npm test` proves schema and deterministic pieces. It does not prove the GM will call tools correctly or the writer will preserve style.

For playable worlds, validate both:

- deterministic checks: typecheck and tests;
- live smoke: start, setup, one or more turns, memory/hook/writer behavior.

When a behavior depends on model tool choice, only a live or realistic smoke can prove it is wired.
