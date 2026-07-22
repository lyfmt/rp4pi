// The normalized, validated shape of a world pack. The loader turns a raw
// `world.yaml` into one of these; every downstream consumer (core wiring, state
// schema, memory policy) reads this type, never the raw YAML. Keeping the
// normalized shape here — separate from the loader — lets tests and state code
// depend on the contract without importing filesystem/YAML machinery.

/** A single custom attribute a world adds on top of the fixed core state. */
export type AttributeSpec =
  | {
      kind: "int";
      name: string;
      description?: string;
      min?: number;
      max?: number;
      initial: number;
    }
  | {
      kind: "string";
      name: string;
      description?: string;
      initial: string;
    }
  | {
      kind: "bool";
      name: string;
      description?: string;
      initial: boolean;
    };

/** Initial values for the fixed core state, provided by the world pack. */
export type WorldInitialState = {
  player: { name: string; status: string; location: string };
  time: { day: number; hour: number };
  scene: { summary: string };
};

/** Memory (OpenViking) configuration a world declares. Connection config
 * (url/apiKey/account) is deliberately NOT here — it lives in settings.json. */
export type WorldMemoryConfig = {
  policy: {
    self: { enabled: boolean };
    peer: { enabled: boolean };
    memory_types: string[];
  };
  /** Absolute paths to the OV schema .yaml files this world ships. */
  schemaPaths: string[];
  /** Directory holding the schema files — what OV's custom_templates_dir points at. */
  schemaDir: string;
  fallbackMemoryTypes: string[];
};

export type WorldLoreSource = {
  path: string;
  defaultKind?: string;
};

export type WorldLoreConfig = {
  sources: WorldLoreSource[];
};

/** A subagent a world declares — a focused child agent the GM can delegate to.
 *
 * This mirrors the `pi-subagents` frontmatter contract: the bootstrap
 * materializes each spec into `.pi/agents/<name>.md`, which pi-subagents
 * discovers as a project agent and spawns as an isolated child Pi process.
 * `tools` becomes the child's `--tools` allowlist (least privilege) and
 * `extensionPath` becomes its `subagentOnlyExtensions` (world-specific tools
 * loaded ONLY in the child, never in the GM's own tool surface). */
export type SubagentSpec = {
  /** Runtime agent name and materialized filename slug. Unique within a world. */
  name: string;
  /** Category. `tool` = ephemeral: spawned per task, does its job, discarded
   * (e.g. the NPC forge). `role` = persistent: a single-character actor that
   * recalls its own action trajectory across delegations to stay in character.
   * Omitting `kind` in the manifest normalizes to `tool` (back-compat). */
  kind: "tool" | "role";
  /** One-line purpose. Required — pi-subagents skips agents without a description. */
  description: string;
  /** Model id (e.g. "provider/id"). Omitted → inherits the pi default model. */
  model?: string;
  /** Thinking level (e.g. "high"), materialized as a `:level` model suffix. */
  thinking?: string;
  /** Tool allowlist for the child (least privilege). Empty ⇒ a tool-less child;
   * omitting `tools` in the manifest normalizes to `[]` (no tools). */
  tools: string[];
  /** Absolute path to the persona file (agent.md) → the child's system prompt. */
  promptPath: string;
  /** Absolute path to the child-only tool-registration extension (index.ts).
   * Undefined when the subagent needs no world-specific tools. */
  extensionPath?: string;
};

/** A writing guide a world declares — one category of writing direction the
 * writer can read on demand (Step_4 of workflow.md: "按需读取写作指导").
 *
 * Mirrors the other declarative world axes (subagents / hooks): the world only
 * declares *what* guidance exists and *where* its text lives; the base platform
 * owns the mechanism — exposing a read-only `read_writing_guide` tool the writer
 * agent calls by `kind` when it decides that guidance is relevant. The guide
 * body is deliberately NOT eagerly injected into the writer prompt; only the
 * catalogue of available kinds is, so the writer pulls the full text on demand.
 * `path` is resolved to an absolute path by the loader (like gmPromptPaths). */
export type WritingGuideSpec = {
  /** Category slug, e.g. style / dialogue / adult. Unique within a world; the
   * key the writer passes to `read_writing_guide`. */
  kind: string;
  /** One-line summary of what this guide covers — shown in the writer's
   * "available guides" catalogue so it can decide whether to read the full text. */
  description: string;
  /** Absolute path to the guide's markdown body. */
  path: string;
  /** Optional gate for later conditional injection ("按需" beyond the writer's
   * own judgement). Reserved: the MVP always exposes every guide's kind in the
   * catalogue and lets the writer choose; `when` is not yet evaluated. */
  when?: string;
};

export const GM_MARKERS = ["chat_history", "hook_prompts"] as const;
export const WRITER_MARKERS = ["writer_base", "writing_guides", "prior_prose", "plot_digest", "story_elements"] as const;
export const WRITER_SYSTEM_MARKERS = ["writer_base", "writing_guides"] as const;

export type PromptMessageRole = "system" | "user" | "assistant";

/** One entry in a prompt template — either a literal message (with a role, the
 * seam that lets a world forge fake user/assistant turns) or a marker the base
 * platform expands into real runtime content at assembly time. `path` entries
 * are read and normalized to `content` by the loader, so runtime assemblers do
 * not touch the filesystem. */
export type PromptTemplateEntry =
  | { kind: "message"; role: PromptMessageRole; content: string }
  | { kind: "marker"; marker: string };

/** A world-declared prompt template for one agent (gm | writer). Absent means
 * the base platform uses its built-in, backward-compatible assembly. */
export type PromptTemplateSpec = {
  entries: PromptTemplateEntry[];
};

export type PromptTemplates = {
  gm?: PromptTemplateSpec;
  writer?: PromptTemplateSpec;
};

/** Final-draft revision policy a world declares (W-F). The writer's draft passes
 * a mandatory revision pipeline before it becomes player-visible prose: two LLM
 * critics — inertia (flags repetition against prior prose) and cliché (flags the
 * world's banned words) — plus an optional style-enhancement pass that runs first
 * when the world ships `writing:` guides. The world only declares the banned-word
 * list here; the base platform owns the critic/enhancer agents and the loop. */
export type RevisionConfig = {
  /** Words/phrases the cliché critic flags in a draft. The critic reasons about
   * variants/near-synonyms too (it is an LLM, not a substring match), using this
   * list as the authoritative "forbidden register" for the world. Empty ⇒ the
   * cliché critic still runs but has no world-specific list to enforce. */
  bannedWords: string[];
};

/** The lifecycle anchor a hook fires at. Each maps onto a runtime seam the core
 * extension already owns:
 *   - `session_start`   — the first turn of a session (a save just loaded / a new
 *                         game began); fires once per session before the GM speaks.
 *   - `turn_start`      — every turn, before the GM agent loop starts; the seam to
 *                         inject context/reminders into the turn the GM is about to run.
 *   - `turn_committed`  — after a turn's prose is rendered and committed; the seam
 *                         for background progression, time/attribute drift, and
 *                         derived bookkeeping.
 * Kept as a small closed set the loader validates by name — new anchors are added
 * deliberately (each needs a runtime seam), never inferred from a manifest. */
export type HookAnchor = "session_start" | "turn_start" | "turn_committed";

export const HOOK_ANCHORS: readonly HookAnchor[] = ["session_start", "turn_start", "turn_committed"];

/** An optional throttle layered on the anchor: the hook fires only once per N
 * turns / in-game hours / in-game days, tracked per (save, hook) so the cadence
 * survives reloads. Omitting `every` (or leaving it empty) fires on every anchor
 * hit. The three gates are independent; when more than one is given the hook
 * fires when ANY has elapsed (union), which is the permissive default a world can
 * reason about without knowing evaluation order. */
export type HookEvery = {
  turns?: number;
  gameHours?: number;
  gameDays?: number;
};

/** A single declarative state edit performed by a `state` hook. `path` addresses
 * either a world attribute (`attributes.<name>`) or a fixed-core field
 * (`time.hour`, `time.day`, `player.status`, `player.location`, `scene.summary`).
 * `op: set` assigns; `op: add` adds a number (numeric targets only). Kept as a
 * path+op pair rather than per-field actions so new addressable fields need no
 * new action type. */
export type HookStateMutation = {
  path: string;
  op: "set" | "add";
  value: number | string | boolean;
};

/** What a hook does when it fires. A discriminated union on `type` so the
 * dispatcher (and a world author) can extend the axis with new action kinds
 * without disturbing existing ones. */
export type HookAction =
  | {
      /** Inject a line of text into the game. `as: prompt` feeds the GM's next
       * turn (guidance the GM weaves in); `as: notice` is a player-facing styled
       * message delivered when idle. Defaults to `prompt`. */
      type: "inject";
      text: string;
      as: "prompt" | "notice";
    }
  | {
      /** Apply declarative, deterministic state edits — no GM involvement (e.g.
       * vigor decays each turn, the clock advances an hour). */
      type: "state";
      mutations: HookStateMutation[];
    }
  | {
      /** Ask the GM to delegate a subagent to produce candidates it can weave in.
       * A hook runs OUTSIDE the GM loop and cannot itself call the `subagent`
       * tool, so this materializes as an injected instruction for the GM's next
       * turn; autonomous out-of-loop spawning is a later, larger axis. */
      type: "delegate";
      subagent: string;
      task: string;
    };

/** A world-declared hook: a lifecycle anchor (`on`), an optional cadence gate
 * (`every`), and an action (`do`). The world only declares; the base platform
 * owns the anchor wiring, the per-save cadence bookkeeping, and the action
 * dispatch — mirroring how the subagents axis works. */
export type HookSpec = {
  /** Unique-within-world slug; also the key the per-save fire-state is tracked under. */
  name: string;
  /** One-line purpose, for docs and logs. */
  description?: string;
  on: HookAnchor;
  every?: HookEvery;
  action: HookAction;
};

/** A fully loaded, validated world pack ready to wire into the runtime. */
export type LoadedWorld = {
  /** Directory slug, e.g. "border-station". */
  name: string;
  displayName: string;
  description: string;
  /** Absolute path to the world pack directory. */
  root: string;
  initialState: WorldInitialState;
  attributes: AttributeSpec[];
  /** Absolute paths to GM prompt files, in order. */
  gmPromptPaths: string[];
  memory: WorldMemoryConfig;
  /** Fixed world lore sources. Loaded at boot into the SQLite lore index. */
  lore: WorldLoreConfig;
  /** Built-in tool groups and world-local tool modules to expose to the GM. */
  tools: { include: string[]; extra: string[] };
  /** Absolute paths to world-local modules that export System definitions. */
  systemModulePaths: string[];
  /** Subagents this world declares (S-A). Materialized to `.pi/agents/` at boot. */
  subagents: SubagentSpec[];
  /** Lifecycle hooks this world declares. Wired into runtime anchors at boot;
   * the base platform owns cadence bookkeeping and action dispatch. */
  hooks: HookSpec[];
  /** Writing guides this world declares (W-A). The writer agent reads them on
   * demand via a read-only `read_writing_guide` tool keyed by `kind`. Empty for
   * worlds that ship no guidance (writer falls back to its base discipline). */
  writingGuides: WritingGuideSpec[];
  /** Final-draft revision policy (W-F). Always present; a world that declares no
   * `revision:` normalizes to an empty banned-word list (the critics still run). */
  revision: RevisionConfig;
  /** Optional per-agent prompt templates (09). Missing members use built-in,
   * backward-compatible prompt assembly. */
  promptTemplates: PromptTemplates;
};
