# IR And Runtime Plan

## Card IR

Create `worlds/<slug>/migration/card-ir.json` before editing runtime files. The exact JSON shape may vary, but these blocks must be present or explicitly marked not applicable:

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

A worked example built from the synthetic fixture card (`test/fixtures/st-cards/sample-card-v2.png`) lives at `references/example-card-ir.json`; it also shows how to mark empty blocks as explicitly not applicable.

## Mutable Concepts

Do not copy variable names as state fields by default. Name the domain concept first.

| ST Signal | Domain Concept | Likely Home |
|---|---|---|
| affection, trust, suspicion | relationship state | System module for rule-driven changes, or memory note; simple public meter can be attribute |
| money, debt, price | economy | System module unless simple attribute is enough |
| HP, SAN, wounds, curse | condition/combat | System module for complex rules; simple status may use attribute |
| inventory, equipment | inventory | acquired/current possessions need state (attributes or a System module); fixed item catalog belongs in lore; remembered mentions may use memory |
| time, location, scene | scene-turn | built-in `time`, `player.location`, `scene.summary` |
| route, quest, chapter | quest/route | attribute, hook, prompt setup, or implementation plan |
| secret identity, culprit, hidden motive | secret | hidden prompt/subagent boundary; never public memory |
| faction plan, NPC autonomy | offscreen | hooks, role/tool subagents, memory |

Each mutable concept needs:

- initial source;
- change trigger;
- legal change path;
- visibility layer;
- validation or discard reason.

## Visibility Layers

Use four layers:

| Layer | Meaning | Project Handling |
|---|---|---|
| `player-only` | Real player may know; protagonist may not | start/setup notes or GM guard, not public state |
| `protagonist-known` | Player character knows | prompt, state, or memory if safe |
| `scene-public` | Others in the scene can know | public prompt/state/memory |
| `hidden-canonical` | True but unrevealed | private GM/module notes or subagent context only |

Hidden-canonical facts do not belong in writer-visible prose packets unless they have been revealed through play.

## Runtime Plan

Create `worlds/<slug>/migration/runtime-plan.md` with these sections:

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
Validation plan
```

## Complexity Decision

| Condition | Decision |
|---|---|
| Stable setting only; no mutable world, no hidden boundary | prompt plus `lore.yaml` / `lore/*.yaml` world pack |
| Small public meters or simple flags | world pack plus `state.yaml` attributes |
| Time drift, background beats, periodic pressure | hooks |
| Long-term character/event recall | OpenViking memory schemas |
| Persistent named character voice | role subagent |
| New character generation during play | tool subagent with base-platform `forge_role`, or a world-local extension like border-station's `forge_character` |
| Complex formulas, combat, economy, inventory, quest ledger, secret ledger | world-local System module (`worlds/<slug>/systems/*.ts` with `defineSystem()`, advanced via `commit_turn`); a `src/` implementation plan only when a capability the System contract lacks is required |

Do not mark a complex mechanic complete just because it appears in GM instructions. If the system must be queried reliably or audited later, it needs state-backed support.

## Runtime Plan Gate

Before building:

- every IR mutable concept has a home or discard reason;
- every hidden fact has a non-public handling rule;
- every opening has a setup route;
- every script finding is either discarded as ST shell or mapped to project work;
- every module selected has a concrete file target in `worlds/<slug>/`.
