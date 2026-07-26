# Source Audit

## Extraction

Prefer card JSON. For image cards, use the bundled scripts under `skills/migrate-st-card/scripts/` (Python >= 3.10, no external dependencies):

```bash
python3 skills/migrate-st-card/scripts/extract_card.py card.png card.json
python3 skills/migrate-st-card/scripts/list_entries.py card.json
python3 skills/migrate-st-card/scripts/list_entries.py card.json --filter initvar
python3 skills/migrate-st-card/scripts/list_entries.py card.json --filter mvu_update
python3 skills/migrate-st-card/scripts/get_entry.py card.json 0,3-5
```

`list_entries.py` and `get_entry.py` accept both an extracted card JSON (embedded `character_book.entries` array) and a standalone ST worldbook export (uid-keyed `entries` dict with `key`/`disable` fields); both are normalized to the embedded V2 shape, and `character_book: null` is treated as no worldbook. Upstream reference: the scripts were adopted from tavern2agent (<https://github.com/Xerxes-2/tavern2agent>, MIT; see `scripts/LICENSE.tavern2agent`).

If python3 is unavailable, ask for an exported JSON card or inspect the image with an equivalent ST card extractor. Do not manually transcribe a large card from screenshots.

## Source Map

| Source | Audit For | Migration Signal |
|---|---|---|
| `description`, `personality`, `scenario`, `system_prompt` | Stable character and setting facts | prompt for stance/brief facts; `lore.yaml` / `lore/*.yaml` for fixed canon; memory seed only for per-save history |
| `first_mes` | Opening scene and missing setup fields | initial state, start flow, route defaults |
| `alternate_greetings`, `group_only_greetings` | Route, difficulty, party, or opening variants | setup choices; never drop silently |
| `creator_notes` | Author constraints, secrets, intended play | hidden rules, style, validation notes |
| `character_book.entries[]` | World facts, rules, scripts, disabled drafts | disposition per entry |
| `[initvar]` | Initial mutable state | `state.yaml` attributes or implementation plan |
| `[mvu_update]` | When and how variables change | mechanics, hooks, tools, reducers |
| Tavern Helper scripts | Zod schema, transforms, game logic, UI | state schema hints; drop ST shell |
| Regex scripts | UI panels, cleanup, hidden injections, game text | extract fields/triggers; drop UI |

## MVU Handling

Treat MVU as a design document plus deterministic guardrails, not as a format to copy.

- `[initvar]` gives initial values; schema defaults may also seed fields.
- `[mvu_update]` gives trigger rules, value ranges, categories, and per-change limits.
- Numeric updates often represent deltas, not absolute replacement.
- Zod transforms and hooks are constraint hints; in this project they should become state schema, tools, hooks, or reducer work.
- MVU display blocks, JSON Patch-like commands, and status panels are ST runtime shell. Strip them.

If an MVU behavior is unclear, inspect the card's schema/scripts. Mark unknown facts as unconfirmed rather than inventing behavior.

## Worldbook Disposition

For every entry, including disabled entries, assign exactly one primary disposition:

| Disposition | Use When |
|---|---|
| `prompt` | Short, stable tone or setting guidance needed every turn |
| `lore` | Structured fixed world facts declared by `lore.yaml` and kept in `worlds/<name>/lore/*.yaml` |
| `memory-seed` | Character/event facts that should seed or guide OpenViking memory |
| `state` | Initial value or current fact that belongs in `state.yaml` |
| `mechanic` | Formula, threshold, trigger, route rule, or tool/reducer requirement |
| `hook` | Periodic or lifecycle behavior fits `hooks.yaml` |
| `subagent` | Requires cognition isolation or long-running role continuity |
| `writing` | Prose style, dialogue, pacing, adult/genre guidance |
| `revision` | Cliche blacklist or final prose review constraint |
| `discarded` | Duplicate, pure UI, ST output patch, or incompatible shell |

Record a short reason. "Disabled" alone is not a reason.

## Script Audit

For Tavern Helper scripts:

```text
registerMvuSchema / z.object -> schema and constraints
custom imported game logic -> mechanic or implementation plan
MagVarUpdate engine shell -> discard
HTML/CSS panels -> extract displayed fields, discard UI
```

For regex scripts:

```text
UpdateVariable cleanup -> discard shell
StatusPlaceHolder hidden output -> discard shell
large HTML replacement -> extract fields, discard UI
large JSON/rules replacement -> mechanic or data
```

## ST Prompt Presets

ST prompt presets (chat-completion presets: `prompts`/`prompt_order` arrays with
marker slots, injection depth/role settings, plus sampler params) configure ST's
prompt assembly, not the card's game semantics. Handling:

- Sampler/model params (temperature, penalties, max tokens): discard — model
  configuration lives in `.pi/agent/settings.json`, never in world packs.
- Prompt-order scaffolding, marker slots, injection depth/position: discard —
  this scaffold owns assembly (`prompts.yaml`; `prompt_template` only when
  default ordering is insufficient).
- Preset prompt text that carries real world flavor, GM stance, or an output
  contract (a "main"/"post-history" block with actual setting or tone rules):
  audit like `system_prompt` — stable stance into `prompts/*.md`, style into
  `writing/*.md`, bans into `revision.yaml`.
- COT scaffolds, "思维链/强化思考" blocks, output-format enforcers: discard the
  shell; if one encodes a real output contract, restate it in
  `prompts/gm-output.md` terms.

A preset is per-user tuning, not card canon: when a card ships with several
presets, audit only what changes game semantics, and record the disposition in
`migration/` like any other source.

## ST Cleanup

Before project files are considered clean, run the residue scan:

```bash
bash scripts/check-st-residue.sh <slug>
```

It scans `worlds/<slug>`, `data`, and `skills/start-game` for ST runtime syntax
(UpdateVariable / JSON Patch / EJS markers / `{{user}}`-style macros), excluding
`worlds/<slug>/migration/**`. Allowed hits are only migration notes under
`worlds/<name>/migration/`. Runtime-facing files should contain project-native
language.
