// Child-only tool extension for the `role-forger` subagent: it simply exposes
// the base-platform `forge_role` tool inside the spawned child. The forging
// logic (persist to dynamic_roles + materialize the agent file + land a
// characters memory) lives in the platform (src/subagents/forge-role.ts) so any
// world's role-forger opts in the same one-line way — mirroring how npc-generator
// wraps a world-local forge_character, but here the capability is generic.
export { forgeRoleTool, parseForgeRoleInput, activate, default } from "../../../../src/subagents/forge-role.ts";
