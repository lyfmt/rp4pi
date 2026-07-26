---
name: migrate-st-card
description: Use when converting, auditing, or planning migration of SillyTavern/ST character cards, PNG/WEBP/JPEG/JSON cards, worldbooks, MVU/initvar rules, Tavern Helper scripts, regex scripts, alternate greetings, or ST prompt presets into this RP agent project.
---

# Migrate ST Card

## Core Rule

Extract the card author's game semantics, then map them into this project's world-pack modules. Do not preserve ST runtime syntax, HTML status panels, JSON Patch output, COT tags, or macro scaffolding.

Migration path:

```text
ST card -> semantic audit -> card IR -> runtime/world plan -> worlds/<name>/ modules
```

## Workflow

1. Extract or load the card JSON.
   Use the bundled zero-dependency scripts in `scripts/` (Python >= 3.10):
   `extract_card.py`, `list_entries.py`, `get_entry.py`. They accept both
   embedded-card worldbooks and standalone ST worldbook exports.

2. Audit sources before writing project files.
   Read `references/source-audit.md` for field coverage, worldbook/MVU/script handling, and ST cleanup rules.

3. Draft `worlds/<slug>/migration/card-ir.json`.
   Read `references/ir-and-runtime-plan.md` for required IR blocks: persona, setting facts, openings, mutable concepts, mechanics, visibility facts, worldbook disposition, script findings, style, and discarded ST patches.

4. Draft `worlds/<slug>/migration/runtime-plan.md`.
   Decide which parts become state attributes, System modules, memory schemas, GM prompts, writing guides, hooks, tools, role subagents, or source-code work.

5. Hand off to `$build-rp-agent`.
   Use that skill to create or edit the actual world pack. Complex mechanics have a project-native home first: a world-local System module (`defineSystem()` + `commit_turn`). Only if a mechanic needs a capability the System contract lacks, stop at a clear implementation plan instead of hiding the rule in prompt prose.

6. Verify no ST residue remains.
   Run the checks in `references/project-mapping.md` before claiming the migration is complete.

## Reference Routing

| Need | Read |
|---|---|
| Card extraction, source field audit, worldbook/MVU/scripts | `references/source-audit.md` |
| Card IR, runtime plan, visibility policy, complexity decision | `references/ir-and-runtime-plan.md` |
| Mapping IR into this repo's `worlds/<name>` modules and validation | `references/project-mapping.md` |

## Hard Constraints

- Every worldbook entry, including disabled entries, needs a disposition.
- Every mutable concept needs a legal runtime home or a discard reason.
- Hidden-canonical facts must not enter player-visible prompts, public memory, or writer inputs.
- Prompt can describe the world; state-changing rules need tools, hooks, memory, or implementation work.
- Alternate greetings and group greetings are route/setup signals, not disposable flavor text.
