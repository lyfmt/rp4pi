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

If python3 is unavailable, alternatives include an exported JSON card, an
equivalent ST card extractor, or selective manual transcription.

## Source Map

| Source | Audit For | Migration Signal |
|---|---|---|
| `description`, `personality`, `scenario`, `system_prompt` | Stable character and setting facts | prompt for stance/brief facts; `lore.yaml` / `lore/*.yaml` for fixed canon; memory seed only for per-save history |
| `first_mes` | Opening scene and missing setup fields | initial state, start flow, route defaults |
| `alternate_greetings`, `group_only_greetings` | Route, difficulty, party, or opening variants | possible setup choices |
| `creator_notes` | Author constraints, secrets, intended play | hidden rules, style, author notes |
| `character_book.entries[]` | World facts, rules, scripts, disabled drafts | possible prompt, lore, state, or omission notes |
| `[initvar]` | Initial mutable state | `state.yaml` attributes or implementation plan |
| `[mvu_update]` | When and how variables change | mechanics, hooks, tools, reducers |
| Tavern Helper scripts | Zod schema, transforms, game logic, UI | state schema hints; optionally omit ST shell |
| Regex scripts | UI panels, cleanup, hidden injections, game text | possible fields/triggers; optionally omit UI |

## MVU Handling

MVU can be treated as a design document rather than copied as-is.

- `[initvar]` gives initial values; schema defaults may also seed fields.
- `[mvu_update]` gives trigger rules, value ranges, categories, and per-change limits.
- Numeric updates often represent deltas, not absolute replacement.
- Zod transforms and hooks can inform state schema, tools, hooks, or reducer work.
- MVU display blocks, JSON Patch-like commands, and status panels can be omitted when they only serve the ST runtime.

If an MVU behavior is unclear, the author can inspect the card's schema/scripts,
mark it as unconfirmed, reinterpret it, or leave it out.

## Worldbook Disposition

When per-entry tracking is useful, these disposition labels are available:

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

Entries may be grouped, split, summarized, or omitted instead of receiving an
individual disposition. Reasons are optional working notes.

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

- Sampler/model params (temperature, penalties, max tokens) can be omitted; model
  configuration normally lives in `.pi/agent/settings.json`.
- Prompt-order scaffolding, marker slots, injection depth/position can be omitted;
  this scaffold owns assembly (`prompts.yaml`; `prompt_template` only when
  default ordering is insufficient).
- Preset prompt text that carries real world flavor, GM stance, or an output
  contract (a "main"/"post-history" block with actual setting or tone rules):
  audit like `system_prompt` — stable stance into `prompts/*.md`, style into
  `writing/*.md`, bans into `revision.yaml`.
- COT scaffolds, "思维链/强化思考" blocks, and output-format enforcers can be
  omitted or adapted; a useful output contract can be restated in
  `prompts/gm-output.md` terms.

A preset is per-user tuning, not card canon. When a card ships with several
presets, authors may retain, adapt, or omit whichever parts fit the target world.
