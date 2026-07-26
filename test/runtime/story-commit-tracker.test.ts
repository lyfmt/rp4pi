import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  drainStoryCommits,
  resetStoryCommitsForTest,
  trackStoryCommit
} from "../../src/runtime/story-commit-tracker.ts";

type TrackerModule = typeof import("../../src/runtime/story-commit-tracker.js");

function trackerUrl(instance: string): string {
  return `${pathToFileURL(new URL("../../src/runtime/story-commit-tracker.ts", import.meta.url).pathname).href}?instance=${instance}`;
}

test("drain waits for tracked commits, including rejected ones", async () => {
  resetStoryCommitsForTest();
  let resolveFirst!: () => void;
  let rejectSecond!: (error: Error) => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const second = new Promise<void>((_resolve, reject) => {
    rejectSecond = reject;
  });
  second.catch(() => {});
  trackStoryCommit(first);
  trackStoryCommit(second);

  let drained = false;
  const drain = drainStoryCommits().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false, "drain must wait for pending commits");

  resolveFirst();
  rejectSecond(new Error("delivery failed"));
  await drain;
  assert.equal(drained, true);

  // Settled commits are dropped: a second drain resolves immediately.
  await drainStoryCommits();
  resetStoryCommitsForTest();
});

test("commits tracked while draining are still awaited", async () => {
  resetStoryCommitsForTest();
  let resolveFirst!: () => void;
  let resolveLate!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const late = new Promise<void>((resolve) => {
    resolveLate = resolve;
  });
  trackStoryCommit(first);

  const seen: string[] = [];
  const drain = drainStoryCommits().then(() => {
    seen.push("drained");
  });
  trackStoryCommit(late);
  resolveFirst();
  await Promise.resolve();
  assert.deepEqual(seen, [], "drain must also wait for the late commit");

  resolveLate();
  await drain;
  assert.deepEqual(seen, ["drained"]);
  resetStoryCommitsForTest();
});

test("the pending set is shared across separately loaded module instances", async () => {
  const producer = (await import(trackerUrl(randomUUID()))) as TrackerModule;
  const consumer = (await import(trackerUrl(randomUUID()))) as TrackerModule;
  producer.resetStoryCommitsForTest();

  let resolveCommit!: () => void;
  const commit = new Promise<void>((resolve) => {
    resolveCommit = resolve;
  });
  producer.trackStoryCommit(commit);

  let drained = false;
  const drain = consumer.drainStoryCommits().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false, "consumer instance must see producer's pending commit");

  resolveCommit();
  await drain;
  assert.equal(drained, true);
  producer.resetStoryCommitsForTest();
});
