# IR And Runtime Plan

## Card IR

`worlds/<slug>/migration/card-ir.json` is an optional, free-form working artifact.
Use any structure that helps the migration. The following shape is only an example:

```json
{
  "version": 1,
  "source": {},
  "persona": [],
  "settingFacts": [],
  "playerSetup": [],
  "openings": [],
  "mechanics": [],
  "mutableConcepts": [],
  "visibilityFacts": [],
  "memoryRules": [],
  "worldbookEntries": [],
  "scriptFindings": [],
  "style": {},
  "discardedStRuntimePatches": []
}
```

A worked example built from the synthetic fixture card
(`test/fixtures/st-cards/sample-card-v2.png`) lives at
`references/example-card-ir.json`. It illustrates one level of detail, not a required schema.

## Mutable Concepts

It can be useful to name the domain concept before choosing whether to preserve a
source variable as state.

| ST Signal | Domain Concept | Likely Home |
|---|---|---|
| affection, trust, suspicion | relationship state | System module for rule-driven changes, or memory note; simple public meter can be attribute |
| money, debt, price | economy | System module unless simple attribute is enough |
| HP, SAN, wounds, curse | condition/combat | System module for complex rules; simple status may use attribute |
| inventory, equipment | inventory | acquired/current possessions need state (attributes or a System module); fixed item catalog belongs in lore; remembered mentions may use memory |
| time, location, scene | scene-turn | built-in `time`, `player.location`, `scene.summary` |
| route, quest, chapter | quest/route | attribute, hook, prompt setup, or implementation plan |
| secret identity, culprit, hidden motive | secret | hidden prompt/subagent boundary or omission from public memory |
| faction plan, NPC autonomy | offscreen | hooks, role/tool subagents, memory |

Useful notes for a mutable concept can include:

- initial source;
- change trigger;
- legal change path;
- visibility layer;
- adaptation or omission notes.

## Visibility Layers

One possible visibility vocabulary uses four layers:

| Layer | Meaning | Project Handling |
|---|---|---|
| `player-only` | Real player may know; protagonist may not | start/setup notes or GM guard, not public state |
| `protagonist-known` | Player character knows | prompt, state, or memory if safe |
| `scene-public` | Others in the scene can know | public prompt/state/memory |
| `hidden-canonical` | True but unrevealed | private GM/module notes or subagent context only |

Hidden-canonical facts can remain outside writer-visible prose packets until they
are revealed through play.

## Runtime Plan

`worlds/<slug>/migration/runtime-plan.md` is also optional. A useful outline can include:

```text
Premise
Complexity decision
Selected modules
State roots and attributes
System modules
Memory policy and schemas
Lore sources
Prompt modules
Writing and revision guides
Hooks
Tools or implementation gaps
Subagent roles
Visibility policy
```

## Possible Complexity Mapping

| Condition | Decision |
|---|---|
| Stable setting only; no mutable world, no hidden boundary | prompt plus `lore.yaml` / `lore/*.yaml` world pack |
| Small public meters or simple flags | world pack plus `state.yaml` attributes |
| Time drift, background beats, periodic pressure | hooks |
| Long-term character/event recall | OpenViking memory schemas |
| Persistent named character voice | role subagent |
| New character generation during play | tool subagent with base-platform `forge_role`, or a world-local extension like border-station's `forge_character` |
| Complex formulas, combat, economy, inventory, quest ledger, secret ledger | world-local System module (`worlds/<slug>/systems/*.ts` with `defineSystem()`, advanced via `commit_turn`) or source implementation |

State-backed support is available when a mechanic benefits from reliable queries,
auditable transitions, or persistence. Simpler adaptations may stay in prompts or
omit the mechanic entirely.
