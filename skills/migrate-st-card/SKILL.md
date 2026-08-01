---
name: migrate-st-card
description: Use when converting, auditing, or planning migration of SillyTavern/ST character cards, PNG/WEBP/JPEG/JSON cards, worldbooks, MVU/initvar rules, Tavern Helper scripts, regex scripts, alternate greetings, or ST prompt presets into this RP agent project.
---

# Migrate ST Card

## Core Rule

Extract whichever card semantics are useful, then adapt them to this project's
world-pack modules. Migration structure, scope, and level of detail are author
choices. ST runtime syntax, HTML panels, JSON Patch output, COT tags, and macro
scaffolding can be translated, summarized, or omitted as appropriate.

One possible migration path:

```text
ST card -> semantic audit -> card IR -> runtime/world plan -> worlds/<name>/ modules
```

## Suggested Workflow

The steps below may be reordered, combined, or skipped.

1. Extract or load the card JSON.
   Use the bundled zero-dependency scripts in `scripts/` (Python >= 3.10):
   `extract_card.py`, `list_entries.py`, `get_entry.py`. `extract_card.py`
   handles character cards; the entry scripts also accept standalone ST
   worldbook exports.

2. Audit any source material that matters to the intended world.
   Read `references/source-audit.md` for field coverage and possible worldbook,
   MVU, script, and prompt-preset interpretations.

3. Optionally draft `worlds/<slug>/migration/card-ir.json`.
   Read `references/ir-and-runtime-plan.md` for an example IR shape covering
   persona, setting facts, openings, mutable concepts, mechanics, visibility,
   worldbook notes, scripts, and style.

4. Optionally draft `worlds/<slug>/migration/runtime-plan.md`.
   Use it to record whichever state attributes, System modules, memory schemas,
   GM prompts, writing guides, hooks, tools, role subagents, or source changes are useful.

5. Hand off to `$build-rp-agent`.
   Use that skill to create or edit the actual world pack. World-local System
   modules (`defineSystem()` + `commit_turn`) are available when a mechanic benefits
   from state-backed behavior; prompt-only or partial adaptations are also valid choices.

## Reference Routing

| Need | Read |
|---|---|
| Card extraction, source field audit, worldbook/MVU/scripts | `references/source-audit.md` |
| Card IR, runtime plan, visibility policy, complexity decision | `references/ir-and-runtime-plan.md` |
| Possible mappings into this repo's `worlds/<name>` modules | `references/project-mapping.md` |

## Freedom Of Form

- `card-ir.json`, `runtime-plan.md`, and per-entry dispositions are optional working artifacts.
- Source entries may be combined, summarized, adapted selectively, or omitted.
- Module mappings in the references are suggestions rather than a fixed contract.
- Visibility, mutable-state, and alternate-opening notes can be kept only where they help the intended experience.
