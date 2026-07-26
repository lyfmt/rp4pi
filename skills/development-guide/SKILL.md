---
name: development-guide
description: Use when changing, debugging, testing, or reviewing this project as a developer, especially subsystem integration work, live smoke validation, runtime hooks, memory behavior, or accumulated project-specific engineering guidance.
---

# Development Guide

## Core Rule

Use this as the top-level development guide for project-specific engineering knowledge. Load only the reference that matches the subsystem being changed.

## References

- World packs: read `references/world-pack.md` when creating or modifying a world (`worlds/<name>/world.yaml`), adding custom state attributes, changing GM prompts/initial state per world, wiring per-world memory policy, or debugging world manifest validation.
- OpenViking memory integration: read `references/openviking.md` when working on OV session commit, `memory_policy`, custom memory schemas, save isolation, memory lookup tools, live smoke tests, or missing long-term memory extraction.
- Render & delivery: read `references/render-delivery.md` when working on writer rendering/revision, the turn activity widget, streaming preview, memory-extraction visibility, story snapshots, or in-flight story-commit draining (lost prose/snapshots on exit or rapid inputs).

## Current Subsystems

- **World packs** (`references/world-pack.md`): the declarative manifest that makes a world a replaceable unit. Start here for anything world-authoring.
- **OpenViking** (`references/openviking.md`): long-term memory service integration.
- **Render & delivery** (`references/render-delivery.md`): the two-pass presentation chain — writer, revision pipeline, turn activity widget, story-commit draining, pi contract gotchas.

Add future subsystem notes as separate files under `references/` and link them here.
