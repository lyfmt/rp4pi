import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const uri = await import(pathToFileURL(new URL("../../src/ov/uri.ts", import.meta.url).pathname).href);

const userSpaceForSave = uri.userSpaceForSave as typeof import("../../src/ov/uri.js").userSpaceForSave;
const memoryRootForSave = uri.memoryRootForSave as typeof import("../../src/ov/uri.js").memoryRootForSave;
const assertUriInCurrentSave =
  uri.assertUriInCurrentSave as typeof import("../../src/ov/uri.js").assertUriInCurrentSave;

test("save_id maps to save-scoped OpenViking user space", () => {
  const saveId = "9f431376-7c35-4d55-a907-b1533a58300f";

  assert.equal(userSpaceForSave(saveId), "save-9f431376-7c35-4d55-a907-b1533a58300f");
});

test("memoryRootForSave returns the save memory root URI", () => {
  const saveId = "9f431376-7c35-4d55-a907-b1533a58300f";

  assert.equal(memoryRootForSave(saveId), "viking://user/save-9f431376-7c35-4d55-a907-b1533a58300f/memories");
});

test("assertUriInCurrentSave accepts only current save memory URIs", () => {
  const saveId = "9f431376-7c35-4d55-a907-b1533a58300f";

  assert.doesNotThrow(() => {
    assertUriInCurrentSave(
      "viking://user/save-9f431376-7c35-4d55-a907-b1533a58300f/memories/characters/Ari.md",
      saveId
    );
  });
  assert.throws(() => {
    assertUriInCurrentSave(
      "viking://user/save-0f1b83a1-5482-4f0b-8e9e-34e441f4e48d/memories/characters/Ari.md",
      saveId
    );
  }, /outside current save/);
  assert.throws(() => {
    assertUriInCurrentSave("viking://user/save-9f431376-7c35-4d55-a907-b1533a58300f/profile.md", saveId);
  }, /outside current save/);
});
