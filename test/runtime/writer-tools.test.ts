import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseLoreEntries } from "../../src/lore/schema.ts";
import { replaceWorldLore } from "../../src/lore/sqlite.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";
import { createStateStore } from "../../src/state/store.ts";

const writerTools = await import(pathToFileURL(new URL("../../src/runtime/writer-tools.ts", import.meta.url).pathname).href);

const buildWriterTools = writerTools.buildWriterTools as typeof import("../../src/runtime/writer-tools.js").buildWriterTools;
const writingGuideCatalogue =
  writerTools.writingGuideCatalogue as typeof import("../../src/runtime/writer-tools.js").writingGuideCatalogue;

type Guide = import("../../src/world/schema.js").WritingGuideSpec;

const fakeState = {
  player: { name: "旅人", status: "清醒", location: "驿站大厅" },
  time: { day: 1, hour: 7 },
  scene: { summary: "晨雾未散。" },
  attributes: {},
  facts: [],
  relationships: []
};

const fakeStateStore = {
  getState: () => fakeState,
  replaceState() {
    return fakeState;
  },
  mutateState() {
    return fakeState;
  },
  getActiveSaveId: () => undefined
} as unknown as import("../../src/state/store.js").StateStore;

const deps = (over: Partial<Parameters<typeof buildWriterTools>[0]> = {}) => ({
  db: { prepare() {}, exec() {} } as unknown as import("../../src/state/sqlite.js").RpDatabase,
  stateStore: fakeStateStore,
  ovClient: undefined,
  writingGuides: [] as Guide[],
  worldName: "demo",
  ...over
});

test("always exposes a read-only get_status tool reflecting current state", async () => {
  const tools = buildWriterTools(deps());
  const status = tools.find((t) => t.name === "get_status");
  assert.ok(status, "get_status must always be available");
  const text = await status!.execute({});
  assert.match(text, /旅人/);
  assert.match(text, /驿站大厅/);
});

test("writer get_status requests writer-audience System projections", async () => {
  let projectionRequest: unknown;
  const systemRuntime = {
    activateSave: () => ({ saveId: "save-a", revision: 3, branchEpoch: 0 }),
    commit: async () => {
      throw new Error("not used");
    },
    project: async (request: unknown) => {
      projectionRequest = request;
      return [
        { system: "progression", revision: 3, value: { level: 2, xp: 75 } }
      ];
    }
  };
  const tools = buildWriterTools(
    deps({
      systemRuntime,
      stateStore: {
        ...fakeStateStore,
        getActiveSaveId: () => "save-a"
      }
    })
  );
  const status = tools.find((tool) => tool.name === "get_status");
  assert.ok(status);

  const text = await status.execute({});

  assert.deepEqual(projectionRequest, {
    saveId: "save-a",
    audience: { kind: "writer" }
  });
  assert.match(text, /progression \(revision 3\): \{"level":2,"xp":75\}/);
});

test("only read-only tools are exposed (no state-mutating tools)", () => {
  const names = buildWriterTools(deps({ ovClient: {} as never, writingGuides: [{ kind: "style", description: "x", path: "/tmp/x.md" }] })).map(
    (t) => t.name
  );
  for (const forbidden of ["update_location", "update_time", "initialize_new_game", "submit_direction_packet", "update_attribute"]) {
    assert.ok(!names.includes(forbidden), `writer must not expose ${forbidden}`);
  }
});

test("memory tools appear only when an OV client is present", () => {
  assert.deepEqual(
    buildWriterTools(deps()).map((t) => t.name).sort(),
    ["get_status", "lookup", "read_lore"]
  );
  const withOv = buildWriterTools(deps({ ovClient: {} as never })).map((t) => t.name);
  assert.ok(withOv.includes("search_memory"));
  assert.ok(withOv.includes("read_memory"));
});

test("writer tools include fixed lore lookup", async () => {
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    replaceWorldLore(
      db,
      "cultivation",
      [],
      parseLoreEntries([
        {
          id: "medicine.gathering-qi-pill",
          kind: "medicine",
          name: "聚气丹",
          aliases: ["聚灵丹"],
          summary: "辅助炼气修士聚拢灵气。",
          body: "适合炼气初中期。",
          tags: ["炼气"]
        }
      ])
    );

    const tools = buildWriterTools({
      db,
      stateStore: createStateStore(db),
      ovClient: undefined,
      writingGuides: [],
      worldName: "cultivation"
    } as never);
    assert.ok(tools.some((tool) => tool.name === "lookup"));
    assert.ok(tools.some((tool) => tool.name === "read_lore"));

    const lookup = tools.find((tool) => tool.name === "lookup");
    assert.match(await lookup!.execute({ query: "聚灵丹" }), /聚气丹/);
  } finally {
    db.close();
  }
});

test("read_writing_guide appears only when the world declares guides and reads bodies on demand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-writer-guides-"));
  try {
    const stylePath = join(dir, "style.md");
    writeFileSync(stylePath, "# 风格\n多用感官细节。\n");
    const guides: Guide[] = [{ kind: "style", description: "叙事语气。", path: stylePath }];

    // Absent when no guides declared.
    assert.ok(!buildWriterTools(deps()).some((t) => t.name === "read_writing_guide"));

    const tools = buildWriterTools(deps({ writingGuides: guides }));
    const guide = tools.find((t) => t.name === "read_writing_guide");
    assert.ok(guide, "read_writing_guide must be present when guides are declared");

    const body = await guide!.execute({ kind: "style" });
    assert.match(body, /多用感官细节/);

    // Unknown kind reports available kinds, never throws.
    const unknown = await guide!.execute({ kind: "nope" });
    assert.match(unknown, /Unknown writing guide kind/);
    assert.match(unknown, /style/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_writing_guide returns a clear error for a missing file rather than throwing", async () => {
  const guides: Guide[] = [{ kind: "style", description: "x", path: "/does/not/exist.md" }];
  const guide = buildWriterTools(deps({ writingGuides: guides })).find((t) => t.name === "read_writing_guide");
  const result = await guide!.execute({ kind: "style" });
  assert.match(result, /Failed to read writing guide "style"/);
});

test("writingGuideCatalogue projects kind + description only", () => {
  const guides: Guide[] = [
    { kind: "style", description: "叙事语气。", path: "/a.md" },
    { kind: "adult", description: "成人指导。", path: "/b.md", when: "adult" }
  ];
  assert.deepEqual(writingGuideCatalogue(guides), [
    { kind: "style", description: "叙事语气。" },
    { kind: "adult", description: "成人指导。" }
  ]);
});
