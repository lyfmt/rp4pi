import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 收编自 tavern2agent 的 ST 卡提取脚本（skills/migrate-st-card/scripts/）
// 对合成 fixture（test/fixtures/st-cards/）的端到端断言。
// 脚本要求 Python >= 3.10；python3 缺失或版本过低时整组 skip 而不是 fail。

// 用 fileURLToPath 而非 URL.pathname——后者对空格/非 ASCII 路径会保留百分号编码
const scriptsDir = fileURLToPath(new URL("../../skills/migrate-st-card/scripts/", import.meta.url));
const fixturesDir = fileURLToPath(new URL("../fixtures/st-cards/", import.meta.url));

const extractScript = join(scriptsDir, "extract_card.py");
const listScript = join(scriptsDir, "list_entries.py");
const getScript = join(scriptsDir, "get_entry.py");

const pythonProbe = spawnSync(
  "python3",
  ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"],
  { encoding: "utf8" }
);
const skip = pythonProbe.status === 0 ? false : "python3 (>= 3.10) 不可用，跳过 ST 迁移脚本测试";

function runPython(script: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("python3", [script, ...args], { encoding: "utf8" });
}

/** 运行脚本并断言 exit 0；失败时把 stdout+stderr 一并带进断言信息。 */
function runOk(script: string, args: string[]): SpawnSyncReturns<string> {
  const result = runPython(script, args);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function extractCardJson(fixture: string): Record<string, any> {
  const result = runOk(extractScript, [join(fixturesDir, fixture)]);
  return JSON.parse(result.stdout);
}

test("extract_card.py reads the synthetic PNG card from its tEXt chara chunk", { skip }, () => {
  const card = extractCardJson("sample-card-v2.png");

  assert.equal(card.spec, "chara_card_v2");
  assert.equal(card.data.name, "临风");
  assert.match(card.data.first_mes, /老杉树/);
  assert.equal(card.data.alternate_greetings.length, 2);

  const entries = card.data.character_book.entries;
  assert.equal(entries.length, 3);
  assert.equal(entries[0].enabled, true);
  assert.equal(entries[2].enabled, false);
  assert.deepEqual(entries[0].keys, ["雾杉镇", "小镇"]);
});

test("extract_card.py reads the synthetic WEBP card via raw byte scan", { skip }, () => {
  const card = extractCardJson("sample-card-v2.webp");

  assert.equal(card.spec, "chara_card_v2");
  assert.equal(card.data.name, "临风");
  assert.equal(card.data.character_book.entries.length, 3);
});

test("extract_card.py reads a WEBP whose EXIF chunk is followed by a base64-alphabet fourcc (ICCP)", { skip }, () => {
  // EXIF 不在末块：base64 扫描会吞入紧邻的 ICCP fourcc，须回退截断后仍能命中
  const card = extractCardJson("sample-card-v2-mid-exif.webp");

  assert.equal(card.spec, "chara_card_v2");
  assert.equal(card.data.name, "临风");
  assert.equal(card.data.character_book.entries.length, 3);
});

test("extract_card.py rejects a standalone ST worldbook JSON with a clear error", { skip }, () => {
  const result = runPython(extractScript, [join(fixturesDir, "worldbook-standalone.json")]);

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, combinedOutput);
  assert.doesNotMatch(combinedOutput, /Traceback/);
  // 报错须点明形态并指引改用世界书脚本，而不是静默产出空 data
  assert.match(result.stderr, /独立世界书/);
  assert.match(result.stderr, /list_entries\.py/);
});

test("extract_card.py passes a character_book: null JSON card through untouched", { skip }, () => {
  const card = extractCardJson("card-nullbook.json");

  assert.equal(card.data.name, "无书者");
  assert.equal(card.data.character_book, null);
});

test("list_entries.py lists embedded worldbook entries and tags the disabled one", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-migration-"));
  try {
    const cardPath = join(dir, "card.json");
    writeFileSync(cardPath, JSON.stringify(extractCardJson("sample-card-v2.png")));

    const result = runOk(listScript, [cardPath]);
    assert.match(result.stdout, /共 3 条世界书条目/);
    assert.match(result.stdout, /触发词: 雾杉镇, 小镇/);
    assert.match(result.stdout, /❌禁用 草稿·旧档案/);
    assert.match(result.stdout, /显示 3 \/ 3 条/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list_entries.py treats character_book: null as no worldbook instead of crashing", { skip }, () => {
  const result = runOk(listScript, [join(fixturesDir, "card-nullbook.json")]);

  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Traceback/);
  assert.match(result.stdout, /共 0 条世界书条目/);
});

test("list_entries.py normalizes a standalone ST worldbook (uid dict, key/disable)", { skip }, () => {
  const result = runOk(listScript, [join(fixturesDir, "worldbook-standalone.json")]);

  assert.match(result.stdout, /共 3 条世界书条目/);
  // `key` 归一化为 keys → 触发词照常显示；uid 数值序保证索引稳定
  assert.match(result.stdout, /\[ {2}0\] 🔒常驻 地点·白鲸灯塔/);
  assert.match(result.stdout, /触发词: 灯塔, 海岬/);
  // `disable: true` 归一化为 enabled: false → 禁用标记
  assert.match(result.stdout, /❌禁用 草稿·海雾异象/);
});

test("get_entry.py shows a standalone worldbook entry with unified fields added", { skip }, () => {
  const result = runOk(getScript, [join(fixturesDir, "worldbook-standalone.json"), "1"]);

  assert.match(result.stdout, /=== \[1\] 人物·守灯人 ===/);
  // 归一化补齐的统一字段
  assert.match(result.stdout, /keys: \["守灯人"\]/);
  assert.match(result.stdout, /secondary_keys: \["老周"\]/);
  assert.match(result.stdout, /enabled: true/);
  // 原始字段保留
  assert.match(result.stdout, /disable: false/);
});

test("get_entry.py keeps embedded card entries unchanged (no regression)", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-migration-"));
  try {
    const cardPath = join(dir, "card.json");
    writeFileSync(cardPath, JSON.stringify(extractCardJson("sample-card-v2.png")));

    const result = runOk(getScript, [cardPath, "0-2"]);
    assert.match(result.stdout, /共 3 条，显示 3 条/);
    assert.match(result.stdout, /=== \[2\] 草稿·旧档案 ===/);
    assert.match(result.stdout, /enabled: false/);
    // 嵌入卡条目本就是 V2 形态，不应被塞进独立世界书的字段名
    assert.doesNotMatch(result.stdout, /keysecondary/);
    assert.doesNotMatch(result.stdout, /disable:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get_entry.py reports a friendly error on character_book: null instead of crashing", { skip }, () => {
  const result = runPython(getScript, [join(fixturesDir, "card-nullbook.json"), "0"]);

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, combinedOutput);
  assert.doesNotMatch(combinedOutput, /Traceback/);
  assert.match(result.stdout, /无效索引，共 0 条/);
});

test("get_entry.py reports a friendly error on malformed index specs instead of a Traceback", { skip }, () => {
  for (const spec of ["2-", "-1", "abc", "0,,3"]) {
    const result = runPython(getScript, [join(fixturesDir, "worldbook-standalone.json"), spec]);

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, `索引串 '${spec}': ${combinedOutput}`);
    assert.doesNotMatch(combinedOutput, /Traceback/, `索引串 '${spec}' 出现 Traceback`);
    assert.match(result.stderr, /无效的索引格式/, `索引串 '${spec}' 无友好报错`);
  }
});

test("list_entries.py rejects an unknown --filter value instead of silently listing everything", { skip }, () => {
  const result = runPython(listScript, [
    join(fixturesDir, "worldbook-standalone.json"),
    "--filter",
    "initvars", // 拼错的 initvar
  ]);

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, combinedOutput);
  // 报错须列出合法值
  assert.match(result.stderr, /未知的 --filter 值: initvars/);
  assert.match(result.stderr, /mvu, mvu_plot, mvu_update, initvar/);
  // 不应打印全集误导用户
  assert.doesNotMatch(result.stdout, /白鲸灯塔/);
});
