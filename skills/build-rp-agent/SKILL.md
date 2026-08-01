---
name: build-rp-agent
description: Use when designing, creating, or refactoring this RP agent project's world packs, fixed lore, GM prompts, state attributes, OpenViking memory schemas, tools, hooks, role subagents, writer guidance, revision policy, role-play authorship boundaries, or overall RP-agent build workflow.
---

# Build RP Agent

## Core Rule

Build worlds as replaceable `worlds/<name>/` packages. Only change `src/` when the world needs a runtime capability the current scaffold cannot express through manifest modules.

Design from the role-play table first, not from a mechanical assistant workflow. Every GM, writer, role subagent, tool agent, hook, and memory schema must have a clear authorship boundary: what it may know, what it may decide, what it may write, and what it must leave to another actor.

Primary loop:

```text
RP contract -> module plan -> world pack files
```

## Role-Play Authorship Boundaries

| Actor | Writes from | May decide | Must not do |
|---|---|---|---|
| GM | referee/director stance | outcomes, deterministic state changes, scene direction, delegation | final prose performance, role interiority beyond evidence, hidden reveals without cause |
| Writer | prose camera bound to the direction packet | wording, rhythm, sensory detail, dialogue texture | new mechanics, state changes, contradicted role actions, facts the scene cannot know |
| Role subagent | first-person in-character stance | that character's speech, intent, action, withholding | GM rulings, player actions, world time, other minds, out-of-role reports before role memory |
| Tool agent | narrow helper stance | candidate output inside its tool brief | authoritative fiction, state writes, character performance unless explicitly scoped |
| Hook | background pressure stance | simple timed prompts or deterministic drift | complex plot decisions, hidden-state adjudication, prose replacement |

When an instruction reads like a generic checklist, rewrite it as an in-world responsibility with a knowledge boundary. If the actor cannot know or author the content in fiction, do not put it in that actor's prompt.

## Workflow

1. Define the RP contract.
   Capture premise, player role, core loop, scene POV, GM authority, writer camera, role-subagent identity boundaries, fixed lore, mutable facts, hidden facts, long-term memory needs, recurring NPCs, and writing style.

2. Choose module homes.
   Read `references/methodology.md` for the decision rules adapted from tavern2agent.

3. Create or update the world pack.
   Read `references/build-flow.md` for file order and commands.

4. Fill module details.
   Read `references/module-guide.md` while editing `world.yaml`, `state.yaml`, `memory.yaml`, `lore.yaml`, `prompts.yaml`, `tools.yaml`, `subagents.yaml`, `hooks.yaml`, `writing.yaml`, and `revision.yaml`.

5. Keep the runtime loop intact.
   GM performs setup, reads status/lore/memory as needed, and delegates role subagents for character action inputs. Core player/time/scene/attributes changes use existing `update_*` tools; System module state changes use `commit_turn` operations. `commit_turn` only advances state, so GM still hands presentation to `submit_direction_packet`. Writer renders read-only from the packet and guides. Revision checks the prose. Successful story delivery records a snapshot and triggers memory and hooks.

## Reference Routing

| Need | Read |
|---|---|
| Step-by-step world creation or refactor flow | `references/build-flow.md` |
| Module-by-module file details | `references/module-guide.md` |
| Design methodology and escalation rules | `references/methodology.md` |

## Stop Conditions

Stop and write an implementation plan instead of editing only world files when the requested behavior needs:

- private hidden state with reliable reveal rules;
- combat/economy/inventory/quest ledgers;
- formulas, bulk settlement, or multi-field transactions;
- a new GM-visible tool or tool group;
- a new state persistence or migration rule;
- reliable enforcement that a GM, writer, role, or tool agent cannot see or author content outside its role;
- a guarantee that prompt text alone cannot enforce.

For those cases, use `development-guide` plus the normal source-code workflow.
