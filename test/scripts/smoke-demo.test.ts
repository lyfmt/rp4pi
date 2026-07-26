import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const smokeDemoScript = new URL("../../scripts/smoke-demo.sh", import.meta.url).pathname;
const smokeDemoLiveScript = new URL("../../scripts/smoke-demo-live.sh", import.meta.url).pathname;

test("smoke-demo live core skips when the service is unavailable", () => {
  const result = spawnSync("bash", [smokeDemoLiveScript], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, OPENVIKING_URL: "http://127.0.0.1:1" },
    encoding: "utf8"
  });

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, combinedOutput);
  assert.match(combinedOutput, /SKIP live OpenViking smoke/);
  assert.doesNotMatch(combinedOutput, /PASS OpenViking append\+commit memory smoke/);
});

test("smoke-demo wrapper still runs project checks before live smoke", () => {
  const wrapper = readFileSync(smokeDemoScript, "utf8");

  assert.match(wrapper, /npm run typecheck/);
  assert.match(wrapper, /npm test/);
  assert.match(wrapper, /start\.sh is executable/);
  assert.match(wrapper, /--mode rpc --offline --no-session --no-extensions/);
  assert.match(wrapper, /PASS extensions load through start\.sh/);
  assert.match(wrapper, /smoke-demo-live\.sh/);
});

test("smoke-demo live core waits a configurable window for OpenViking memory extraction", () => {
  const script = readFileSync(smokeDemoLiveScript, "utf8");

  // glm 级推理提取动辄数分钟：默认 360s，可用 RP_OV_SMOKE_TIMEOUT_SECONDS 覆盖。
  assert.match(script, /RP_OV_SMOKE_TIMEOUT_SECONDS \?\? 360/);
  assert.match(script, /for \(let attempt = 0; attempt < maxAttempts; attempt \+= 1\)/);
});

test("smoke-demo live core still verifies extracted OpenViking memories", () => {
  const script = readFileSync(smokeDemoLiveScript, "utf8");

  assert.match(script, /memories_extracted/);
  assert.match(script, /did not extract RP memories/);
});

test("smoke-demo live core gives OpenViking durable RP facts in the user turn", () => {
  const script = readFileSync(smokeDemoLiveScript, "utf8");

  assert.match(script, /playerInput: "[^"]*林澈[^"]*银色钥匙[^"]*北门已经打开/);
});
