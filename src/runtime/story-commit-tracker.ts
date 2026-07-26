// In-flight story-commit registry, shared process-wide the same way
// turn-events.ts is (Symbol.for on globalThis): each extension may load its own
// module instance, but they must all see the SAME pending set.
//
// Why this exists: a story commit (prose delivery → snapshot → turn-rendered
// listeners: turn_committed hooks + OpenViking memory) runs in the background
// after agent_end — nothing in pi awaits it. pi awaits `session_shutdown`
// handlers BEFORE invalidating extension contexts, so every extension that
// tears anything down on shutdown (unsubscribing its turn-rendered listener,
// closing resources) must first `drainStoryCommits()`. Draining only in the
// producer's own handler is not enough — session_shutdown handlers run in
// extension activation order, and core (which owns the turn_committed hook
// listener) activates BEFORE two-pass-render.
type StoryCommitRegistry = {
  pending: Set<Promise<void>>;
};

type StoryCommitGlobal = typeof globalThis & {
  [key: symbol]: StoryCommitRegistry | undefined;
};

const STORY_COMMITS_KEY = Symbol.for("my-rp-agent.story-commits");

function registry(): StoryCommitRegistry {
  const root = globalThis as StoryCommitGlobal;
  const existing = root[STORY_COMMITS_KEY];
  if (existing) {
    return existing;
  }
  const created = { pending: new Set<Promise<void>>() };
  root[STORY_COMMITS_KEY] = created;
  return created;
}

/** Track a background story commit until it settles. */
export function trackStoryCommit(completion: Promise<void>): void {
  const { pending } = registry();
  pending.add(completion);
  const drop = (): void => {
    pending.delete(completion);
  };
  completion.then(drop, drop);
}

/**
 * Wait for every in-flight story commit to settle (never rejects). Each link in
 * a commit chain is individually bounded (idle-poll timeout, OV request
 * timeout), so this cannot hang shutdown indefinitely.
 */
export async function drainStoryCommits(): Promise<void> {
  // Commits can be tracked while draining (not in practice — agent_end has
  // ended — but loop until quiescent so the guarantee is unconditional).
  const { pending } = registry();
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

/** Drop all tracked commits — used by tests to isolate per-case state. */
export function resetStoryCommitsForTest(): void {
  registry().pending.clear();
}
