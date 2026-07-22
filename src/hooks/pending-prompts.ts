import type { RuntimeMessage } from "../runtime/prose-message.ts";

// Where a hook's `inject as:prompt` / `delegate` guidance lands. A hook runs
// OUTSIDE the GM agent loop, so it cannot speak to the GM directly — instead we
// stage its text and let the core extension's `context` handler splice it into
// the GM's view for the upcoming generation. This keeps the guidance ephemeral
// (it never becomes a persistent session entry) yet visible to the GM exactly
// when it should be, without re-triggering a turn the way a real message send
// would.
//
// Two buckets, rotated per turn, give the three anchors distinct timing:
//   - `active`  — spliced into THIS turn's context. `session_start` / `turn_start`
//                 hooks fire in `before_agent_start` and queue here, so their
//                 guidance is present for the turn the GM is about to run.
//   - `pending` — queued during `turn_committed` (which fires AFTER the turn),
//                 promoted to `active` at the next `before_agent_start`, so its
//                 guidance shows up on the GM's NEXT turn.
// `beginTurnPrompts()` performs the rotation: last turn's `active` guidance
// expires and `pending` becomes the new `active`. Because `active` is only read
// (never drained) by the context handler, one turn's guidance survives across
// every model call within that turn, not just the first.
//
// Module-level singleton, mirroring the bootstrap/activateSave pattern: pi runs
// one GM session per process and subagents are separate processes, so there is
// no cross-session contention to key on here.

let activePrompts: string[] = [];
let pendingPrompts: string[] = [];

/** Queue guidance to be spliced into the CURRENT turn's GM context. */
export function queueActiveHookPrompt(text: string): void {
  activePrompts.push(text);
}

/** Queue guidance to be spliced into the NEXT turn's GM context. */
export function queuePendingHookPrompt(text: string): void {
  pendingPrompts.push(text);
}

/**
 * Rotate the buckets at a turn boundary: this turn's expiring `active` guidance
 * is dropped and any `pending` guidance (queued by the previous turn's
 * `turn_committed` hooks) becomes `active`. Call once per `before_agent_start`,
 * BEFORE firing `session_start` / `turn_start` hooks so their fresh guidance is
 * appended on top of the promoted pending set.
 */
export function beginTurnPrompts(): void {
  activePrompts = pendingPrompts;
  pendingPrompts = [];
}

/** The guidance to splice into this turn's GM context (read-only, not drained). */
export function activeHookPrompts(): readonly string[] {
  return activePrompts;
}

/** Wrap one queued prompt as a GM-visible context message. Role `user` so every
 * provider accepts it mid-conversation (a mid-history `system` message is not
 * universally allowed); world authors phrase the text as directorial guidance. */
export function hookPromptMessage(text: string): RuntimeMessage {
  return { role: "user", content: text };
}

/** Drop both buckets — used by tests to isolate per-case prompt state. */
export function resetHookPromptsForTest(): void {
  activePrompts = [];
  pendingPrompts = [];
}
