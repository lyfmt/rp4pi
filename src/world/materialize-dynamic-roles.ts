import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listDynamicRoles } from "../state/dynamic-roles.ts";
import type { RpDatabase } from "../state/sqlite.ts";
import { RP_DYNAMIC_ROLE_MARKER, RP_SUBAGENT_MARKER, renderAgentMarkdown } from "./materialize-subagents.ts";
import { readSubagentSettings } from "./subagent-settings.ts";

// Project a save's GM-forged roles (dynamic-roles.ts) into `.pi/agents/` so
// pi-subagents can spawn them. This is the runtime twin of
// materializeWorldSubagents: that one writes the world's STATIC subagents at
// startup; this one writes the ACTIVE SAVE's forged roles whenever a save is
// bound (load / initialize) and whenever forge_role adds one mid-session.
//
// Scope discipline — three kinds of file can share `.pi/agents/`:
//   • hand-authored (writer.md)        — no marker; never touched.
//   • world-static (RP_SUBAGENT_MARKER) — owned by materializeWorldSubagents.
//   • forged dynamic (this marker)      — owned here.
// So this function cleans ONLY its own marker before rewriting, leaving the
// world's static agents intact, and refuses to collide with either of the other
// two kinds (a forged name must not shadow a static subagent or a hand file).

/**
 * Rewrite the active save's forged-role files under `<projectRoot>/.pi/agents/`.
 * Removes previously-forged files (so a save switch never leaves another save's
 * roles discoverable), then writes this save's set from the db. Returns the
 * absolute paths written. Idempotent for a given (save, db) state.
 */
export function materializeDynamicRoles(projectRoot: string, db: RpDatabase, saveId: string): string[] {
  const dir = join(projectRoot, ".pi", "agents");
  mkdirSync(dir, { recursive: true });

  // Drop only our own previously-forged files; leave world-static + hand files.
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const path = join(dir, entry);
    if (fileHasMarker(path, RP_DYNAMIC_ROLE_MARKER)) {
      rmSync(path, { force: true });
    }
  }

  const written: string[] = [];
  const subagentSettings = readSubagentSettings(projectRoot);
  for (const role of listDynamicRoles(db, saveId)) {
    const file = join(dir, `${role.name}.md`);
    // After our cleanup, anything still at this path is a world-static agent or
    // a hand-authored file — either way, refuse to clobber it. A forged role
    // must pick a name that does not shadow those.
    if (existsSync(file)) {
      throw new Error(
        `Forged role "${role.name}" would overwrite .pi/agents/${role.name}.md, which is a world subagent or hand-authored file. Forge it under a different name.`
      );
    }
    writeFileSync(file, renderDynamicRoleMarkdown(projectRoot, role, subagentSettings[role.name]), "utf8");
    written.push(file);
  }
  return written;
}

/** Render one forged role as a role-kind agent file (persona from the db). */
export function renderDynamicRoleMarkdown(
  projectRoot: string,
  role: { name: string; description: string; persona: string },
  settings: { model?: string; thinking?: string } = {}
): string {
  return renderAgentMarkdown({
    name: role.name,
    kind: "role",
    description: role.description,
    model: settings.model,
    thinking: settings.thinking,
    tools: [],
    persona: role.persona,
    projectRoot,
    markerNote: `${RP_DYNAMIC_ROLE_MARKER} — GM-forged role, projected from the active save's db. Edits are overwritten.`
  });
}

function fileHasMarker(path: string, marker: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(marker);
  } catch {
    return false;
  }
}

// Re-exported for callers that need to reason about which markers exist.
export { RP_DYNAMIC_ROLE_MARKER, RP_SUBAGENT_MARKER };
