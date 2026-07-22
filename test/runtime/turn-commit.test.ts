import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { commitTurn } from "../../src/runtime/turn-commit.ts";
import { isWriterProseMessage, type RuntimeMessage } from "../../src/runtime/prose-message.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { parseStorySnapshotEnvelope } from "../../src/state/snapshot-envelope.ts";
import { initializeSchema, openRpDatabase, type RpDatabase } from "../../src/state/sqlite.ts";
import {
  createStorySnapshotCoordinator,
  type StorySnapshotCoordinator
} from "../../src/state/story-snapshot-coordinator.ts";
import { createStateStore, type StateStore } from "../../src/state/store.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";

function renderPacket() {
  return {
    storyElements: {
      currentSituation: "A courier is at the door.",
      playerIntent: "The player helps the courier.",
      visibleChanges: ["The courier arrives."],
      presentCharacters: ["player", "courier"],
      characterActions: [],
      tension: "The sealed letter still needs delivery."
    },
    needsRender: true,
    directReply: ""
  };
}

test("commitTurn captures a full envelope only after delivery completion", async () => {
  await withRuntimeHarness(async ({ db, stateStore, saveId, storySnapshots }) => {
    const delivery = controlledDelivery();
    const result = await commitTurn({
      stateStore,
      storySnapshots,
      packet: renderPacket(),
      writerClient: { async render() { return "The courier staggers into view."; } },
      deliverCustomMessage: delivery.deliver
    });

    assert.equal(result.rendered, true);
    assert.equal(result.prose, "The courier staggers into view.");
    assert.equal(countSnapshots(db, saveId), 0);
    assert.equal(delivery.messages.length, 1);
    assert.equal(isWriterProseMessage(delivery.messages[0]), true);

    delivery.release();
    const completion = await result.completion;
    assert.deepEqual(completion, { snapshotTurnNo: 1 });
    const envelope = latestEnvelope(db, saveId);
    assert.equal(envelope.core.payload.scene.summary, "Start");
    assert.deepEqual(envelope.systems.progression, { version: 1, payload: { value: 1 } });
  });
});

test("commitTurn does not deliver or snapshot when writer fails", async () => {
  await withRuntimeHarness(async ({ db, stateStore, saveId, storySnapshots }) => {
    let delivered = false;
    await assert.rejects(
      commitTurn({
        stateStore,
        storySnapshots,
        packet: renderPacket(),
        writerClient: { async render() { throw new Error("writer failed"); } },
        deliverCustomMessage() {
          delivered = true;
          return Promise.resolve();
        }
      }),
      /writer failed/
    );
    assert.equal(delivered, false);
    assert.equal(countSnapshots(db, saveId), 0);
  });
});

test("delivery failure rejects completion without capturing", async () => {
  await withRuntimeHarness(async ({ db, stateStore, saveId, storySnapshots }) => {
    const result = await commitTurn({
      stateStore,
      storySnapshots,
      packet: renderPacket(),
      writerClient: { async render() { return "Rendered."; } },
      deliverCustomMessage: () => Promise.reject(new Error("send failed"))
    });

    assert.equal(result.rendered, true);
    await assert.rejects(result.completion, /send failed/);
    assert.equal(countSnapshots(db, saveId), 0);
  });
});

test("snapshot failure rejects completion after delivery and preserves prior state commits", async () => {
  await withRuntimeHarness(async ({ db, stateStore, saveId, storySnapshots }) => {
    const delivery = controlledDelivery();
    const failingSnapshots: StorySnapshotCoordinator = {
      ...storySnapshots,
      captureSuccessfulStory() {
        throw new Error("snapshot failed");
      }
    };
    const result = await commitTurn({
      stateStore,
      storySnapshots: failingSnapshots,
      packet: renderPacket(),
      writerClient: { async render() { return "Rendered."; } },
      deliverCustomMessage: delivery.deliver
    });

    delivery.release();
    await assert.rejects(result.completion, /snapshot failed/);
    assert.equal(delivery.accepted, true);
    assert.equal(countSnapshots(db, saveId), 0);
    assert.equal(stateStore.getState().scene.summary, "Start");
  });
});

test("needsRender=false delivers direct reply but never captures a story snapshot", async () => {
  await withRuntimeHarness(async ({ db, stateStore, saveId, storySnapshots }) => {
    const delivery = controlledDelivery();
    const result = await commitTurn({
      stateStore,
      storySnapshots,
      packet: { needsRender: false, directReply: "Noted." },
      writerClient: { async render() { throw new Error("should not render"); } },
      deliverCustomMessage: delivery.deliver
    });

    assert.equal(result.rendered, false);
    assert.equal(result.directReply, "Noted.");
    assert.deepEqual(delivery.messages, [{ role: "assistant", content: "Noted." }]);
    delivery.release();
    await result.completion;
    assert.equal(countSnapshots(db, saveId), 0);
  });
});

function controlledDelivery() {
  let resolve!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectDelivery) => {
    resolve = resolvePromise;
    rejectPromise = rejectDelivery;
  });
  const control = {
    messages: [] as RuntimeMessage[],
    accepted: false,
    deliver(message: RuntimeMessage): Promise<void> {
      control.messages.push(message);
      return promise;
    },
    release(): void {
      control.accepted = true;
      resolve();
    },
    reject(error: Error): void {
      rejectPromise(error);
    }
  };
  return control;
}

function countSnapshots(db: RpDatabase, saveId: string): number {
  return (db
    .prepare("SELECT COUNT(*) AS count FROM turn_snapshots WHERE save_id = ?")
    .get(saveId) as { count: number }).count;
}

function latestEnvelope(db: RpDatabase, saveId: string) {
  const row = db
    .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no DESC LIMIT 1")
    .get(saveId) as { state_json: string };
  return parseStorySnapshotEnvelope(JSON.parse(row.state_json));
}

async function withRuntimeHarness(
  run: (harness: {
    db: RpDatabase;
    stateStore: StateStore;
    saveId: string;
    storySnapshots: StorySnapshotCoordinator;
  }) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rp-turn-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(save.id, createInitialState({ scene: { summary: "Start" } }));
    const progression = defineSystem({
      name: "progression",
      version: 1,
      initialize: () => ({ value: 1 }),
      parse(payload) {
        if (typeof payload !== "object" || payload === null || !Number.isInteger((payload as { value?: unknown }).value)) {
          throw new Error("invalid progression");
        }
        return payload as { value: number };
      },
      commands: {},
      project: (_context, state) => state
    });
    const registry = createSystemRegistry([progression], { capabilities: new Map() });
    const runtime = createSystemRuntime({ db, registry });
    runtime.activateSave(save.id);
    const storySnapshots = createStorySnapshotCoordinator({ db, registry, systemRuntime: runtime });
    await run({ db, stateStore, saveId: save.id, storySnapshots });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
