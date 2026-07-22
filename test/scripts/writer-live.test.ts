import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const scriptPath = new URL("../../scripts/smoke-writer-live.sh", import.meta.url).pathname;
const demoDocPath = new URL("../../docs/demo.md", import.meta.url).pathname;
const readmePath = new URL("../../README.md", import.meta.url).pathname;

test("writer live smoke can be disabled for automated test runs", () => {
  assert.equal(existsSync(scriptPath), true);

  const result = spawnSync("bash", [scriptPath], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, RP_WRITER_LIVE_SMOKE: "0" },
    encoding: "utf8"
  });

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, combinedOutput);
  assert.match(combinedOutput, /SKIP live writer smoke/);
  assert.doesNotMatch(combinedOutput, /PASS live writer smoke/);
});

test("writer live smoke uses the real pi entrypoint and current main model settings", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.doesNotMatch(script, /PI_WRITER_SMOKE_HOOK/);
  assert.match(script, /\.\/start\.sh/);
  assert.match(script, /--approve/);
  assert.match(script, /--session-id/);
  assert.match(script, /-p/);
  assert.match(script, /RP_SQLITE_PATH/);
  assert.doesNotMatch(script, /createConfiguredWriterClient/);
  assert.doesNotMatch(script, /modelRegistry/);
  assert.doesNotMatch(script, /sessionManager/);
});

test("writer live smoke verifies post-render hook and memory side effects", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /hook_fire_state/);
  assert.match(script, /ov_session_bindings/);
  assert.match(script, /clock-drift/);
  assert.match(script, /OpenViking append reached/);
});

test("writer live smoke command is documented", () => {
  const demoDoc = readFileSync(demoDocPath, "utf8");
  const readme = readFileSync(readmePath, "utf8");

  assert.match(demoDoc, /bash scripts\/smoke-writer-live\.sh/);
  assert.match(readme, /bash scripts\/smoke-writer-live\.sh/);
});
