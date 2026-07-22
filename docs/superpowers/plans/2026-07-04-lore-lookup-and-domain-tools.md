# 固定资料 Lookup 与叙事领域工具底座实现计划

> **状态（2026-07-10）：部分保留。** lore lookup 与 `get_status` 已保留；中央
> DomainEvent、facts/relationships 聚合写入和聚合式 `commit_turn` 已由
> `2026-07-10-domain-runtime-rollback.md` 撤销。下文相关任务仅作历史记录，
> 不是当前运行时说明。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 RP 底座增加一套世界固定资料的 SQLite 检索能力，并补齐 `get_status`、`commit_turn`、关系变化、状态变化等核心叙事工具。

**架构：** 世界包继续作为唯一源头：`lore.yaml` 声明固定资料源，`lore/*.yaml` 存人物、地点、背景、等级、丹药等可 diff 的源文件；启动时导入 SQLite 只读索引。运行时工具分三类：`core.lookup` 查固定资料，`core.memory` 查 OpenViking 存档记忆，`core.state` 读写当前存档状态，并用新的 `commit_turn` 聚合本轮状态事件和 writer 方向包。

**技术栈：** TypeScript、Node 24 `node:sqlite`、`yaml`、`node:test`、现有 Pi tool contract。

---

## 边界与术语

| 术语 | 定义 | 存储 |
| --- | --- | --- |
| 固定资料 | 不随存档变化的世界权威信息，例如人物设定、地点、背景、等级、丹药、功法、规则 | SQLite lore index，源文件在 world pack |
| 当前状态 | 当前存档的确定性事实，例如玩家状态、地点、时间、场景、属性、关系 | SQLite `latest_states` JSON |
| 长期记忆 | 玩家在这个存档中经历过的旧事件、旧人物、旧承诺 | OpenViking |
| 领域事件 | GM 本轮裁定成立、需要落地到当前状态的变更 | `commit_turn.events` |

固定资料不得写进 OpenViking；长期经历不得写进固定资料；当前状态不得靠 prompt 记忆维持。

## 文件结构

### 创建

- `src/lore/schema.ts`：固定资料源文件的标准类型、解析与校验。
- `src/lore/sqlite.ts`：SQLite lore 表结构与读写仓储。
- `src/lore/importer.ts`：从 `LoadedWorld.lore` 导入固定资料到 SQLite。
- `src/lore/search.ts`：确定性检索、排序、格式化。
- `src/tools/lookup/lookup-lore.ts`：GM 可见 `lookup` 工具。
- `src/tools/lookup/read-lore.ts`：GM 可见 `read_lore` 工具。
- `src/tools/state/get-status.ts`：GM 可见 `get_status` 工具。
- `src/tools/state/commit-turn.ts`：GM 可见 `commit_turn` 聚合工具。
- `src/tools/state/domain-events.ts`：状态事件、关系事件解析与应用。
- `test/lore/schema.test.ts`
- `test/lore/sqlite.test.ts`
- `test/lore/importer.test.ts`
- `test/lore/search.test.ts`
- `test/state/commit-turn.test.ts`
- `test/state/get-status.test.ts`
- `test/tools/lookup-lore.test.ts`

### 修改

- `src/world/schema.ts`：新增 `WorldLoreConfig` 与 `LoadedWorld.lore`。
- `src/world/loader.ts`：支持 `lore: ./lore.yaml` 模块字段。
- `src/state/schema.ts`：为存档状态增加 `facts`、`relationships`，保持旧档兼容。
- `src/state/status.ts`：输出更完整的 GM brief。
- `src/state/sqlite.ts`：初始化 lore 表。
- `src/runtime/bootstrap.ts`：加载 active world 后导入 lore index。
- `src/tools/registry.ts`：新增 `core.lookup` 工具组，注册 `get_status` 与 `commit_turn`。
- `src/runtime/writer-tools.ts`：writer 只读工具增加 `lookup`、`read_lore`、复用 `get_status`。
- `src/runtime/direction-packet.ts`：让 `commit_turn` 复用方向包解析。
- `worlds/_template/world.yaml`：新增 `lore: ./lore.yaml`。
- `worlds/_template/tools.yaml`：默认包含 `core.lookup`。
- `worlds/_template/lore.yaml`：模板 lore 声明。
- `worlds/_template/lore/*.yaml`：最小示例。
- `worlds/border-station/world.yaml`、`worlds/border-station/tools.yaml`：启用 lore。
- `skills/development-guide/references/world-pack.md`：补充 lore/lookup 轴。

---

## 工具面目标

### `lookup`

查固定资料短结果。

```json
{
  "query": "聚气丹 炼气",
  "kind": "medicine",
  "limit": 5
}
```

返回最多 5 条，每条包含 `id`、`kind`、`name`、命中原因、摘要。默认不返回全文。

### `read_lore`

按 `lookup` 返回的 `id` 读取完整固定资料。

```json
{
  "id": "medicine.gathering-qi-pill"
}
```

### `get_status`

读取当前存档 GM brief。包含玩家、时间、场景、attributes、关键 facts、关系摘要。状态未变化时允许重复读取，不做 `fate-sandbox` 的重复读取拒绝，避免当前底座调试成本过高。

### `commit_turn`

聚合本轮状态落地和 writer 方向包。

```json
{
  "summary": "玩家救下受伤信使并取得密信。",
  "events": [
    { "kind": "player-status", "status": "护送韩越，携带未送达密信" },
    { "kind": "location", "location": "北门驿站内厅" },
    {
      "kind": "relationship",
      "source": "player",
      "target": "韩越",
      "stance": "trusted",
      "summary": "韩越开始把玩家视为可托付密信的人。",
      "evidence": "玩家替他挡下盘问并答应送信。"
    }
  ],
  "direction": {
    "needsRender": true,
    "storyElements": {
      "currentSituation": "...",
      "playerIntent": "...",
      "visibleChanges": ["..."],
      "presentCharacters": ["韩越"],
      "characterActions": [{ "name": "韩越", "action": "..." }],
      "tension": "..."
    },
    "directReply": ""
  }
}
```

返回值继续携带 `{ packet }`，并设置 `terminate: true`，让现有 writer 接管流程。旧 `submit_direction_packet` 先保留，但 prompt 改为优先使用 `commit_turn`。

---

## 任务 1：扩展状态模型，支持 facts 与 relationships

**文件：**
- 修改：`src/state/schema.ts`
- 修改：`src/state/status.ts`
- 测试：`test/state/status.test.ts`
- 测试：`test/state/sqlite.test.ts`

- [ ] **步骤 1：编写失败测试：旧状态可 hydrate，新状态带默认空集合**

```ts
test("parseState hydrates legacy saves with empty facts and relationships", () => {
  const state = parseState({
    player: { name: "Ari", status: "Ready", location: "Gate" },
    time: { day: 1, hour: 8 },
    scene: { summary: "Opening." },
    attributes: {}
  });

  assert.deepEqual(state.facts, []);
  assert.deepEqual(state.relationships, []);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/state/status.test.ts test/state/sqlite.test.ts
```

预期：FAIL，`facts` 或 `relationships` 字段不存在。

- [ ] **步骤 3：实现最小状态扩展**

在 `RpState` 增加：

```ts
export type RpFact = {
  id: string;
  kind: string;
  subject?: string;
  text: string;
  visibility: "public" | "gm";
  source: string;
};

export type RpRelationship = {
  source: string;
  target: string;
  stance: string;
  summary: string;
  evidence: string;
  visibility: "public" | "gm";
};
```

`createInitialState` 默认 `facts: []`、`relationships: []`。`parseState` 对旧档缺省为空，对新档做最小字段校验。

- [ ] **步骤 4：更新 `formatStatus`**

状态输出追加：

```text
属性：...
事实：...
关系：...
```

空集合省略对应段，避免噪声。

- [ ] **步骤 5：运行测试验证通过**

```bash
npm test -- test/state/status.test.ts test/state/sqlite.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/state/schema.ts src/state/status.ts test/state/status.test.ts test/state/sqlite.test.ts
git commit -m "feat(state): add facts and relationships"
```

---

## 任务 2：定义固定资料源文件格式

**文件：**
- 创建：`src/lore/schema.ts`
- 测试：`test/lore/schema.test.ts`

- [ ] **步骤 1：编写失败测试：解析人物、地点、丹药三类条目**

```ts
test("parseLoreEntries accepts generic lore entries", () => {
  const entries = parseLoreEntries([
    {
      id: "medicine.gathering-qi-pill",
      kind: "medicine",
      subtype: "pill",
      name: "聚气丹",
      aliases: ["聚灵丹"],
      summary: "辅助炼气修士聚拢灵气。",
      body: "适合炼气初中期。",
      tags: ["丹药", "炼气"],
      visibility: "public",
      fields: { grade: "一阶" },
      relations: [{ type: "usable_by", target: "rank.qi-refining" }]
    }
  ]);

  assert.equal(entries[0]?.id, "medicine.gathering-qi-pill");
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/lore/schema.test.ts
```

- [ ] **步骤 3：实现 `LoreEntry` 类型与解析**

```ts
export type LoreVisibility = "public" | "gm" | "secret";

export type LoreEntry = {
  id: string;
  kind: string;
  subtype?: string;
  name: string;
  aliases: string[];
  summary: string;
  body: string;
  tags: string[];
  visibility: LoreVisibility;
  fields: Record<string, unknown>;
  relations: Array<{ type: string; target: string; note?: string }>;
  sourcePath?: string;
};
```

规则：
- `id`、`kind`、`name`、`summary` 必填。
- `aliases`、`tags`、`relations` 缺省为空数组。
- `body` 缺省为空字符串。
- `visibility` 缺省 `public`。
- `fields` 缺省 `{}`。
- `kind` 不做枚举限制，底座支持任意世界类型。

- [ ] **步骤 4：补充错误测试**

覆盖空 id、重复 alias 非字符串、relations target 非字符串。

- [ ] **步骤 5：运行测试验证通过**

```bash
npm test -- test/lore/schema.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/lore/schema.ts test/lore/schema.test.ts
git commit -m "feat(lore): define fixed lore entry schema"
```

---

## 任务 3：增加 SQLite lore 表与仓储

**文件：**
- 修改：`src/state/sqlite.ts`
- 创建：`src/lore/sqlite.ts`
- 测试：`test/lore/sqlite.test.ts`
- 修改：`test/state/sqlite.test.ts`

- [ ] **步骤 1：编写失败测试：schema 创建 lore 表**

```ts
test("initializeSchema creates lore tables", () => {
  const db = openRpDatabase(":memory:");
  initializeSchema(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.ok(names.some((row) => row.name === "lore_entries"));
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/lore/sqlite.test.ts test/state/sqlite.test.ts
```

- [ ] **步骤 3：新增表**

在 `initializeSchema` 添加：

```sql
CREATE TABLE IF NOT EXISTS lore_entries (
  world_name TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subtype TEXT,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  visibility TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_name, id)
);

CREATE TABLE IF NOT EXISTS lore_aliases (
  world_name TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  PRIMARY KEY (world_name, entry_id, alias)
);

CREATE TABLE IF NOT EXISTS lore_relations (
  world_name TEXT NOT NULL,
  from_entry_id TEXT NOT NULL,
  type TEXT NOT NULL,
  to_entry_id TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY (world_name, from_entry_id, type, to_entry_id)
);

CREATE TABLE IF NOT EXISTS lore_search_index (
  world_name TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  token_text TEXT NOT NULL,
  PRIMARY KEY (world_name, entry_id)
);

CREATE TABLE IF NOT EXISTS lore_sources (
  world_name TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (world_name, path)
);
```

- [ ] **步骤 4：实现仓储函数**

`src/lore/sqlite.ts` 提供：

```ts
replaceWorldLore(db, worldName, sources, entries)
getLoreEntry(db, worldName, id)
listLoreEntries(db, worldName)
searchLoreRows(db, worldName)
```

`replaceWorldLore` 对单个 `world_name` 全量替换，避免删除其它世界资料。

- [ ] **步骤 5：运行测试验证通过**

```bash
npm test -- test/lore/sqlite.test.ts test/state/sqlite.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/state/sqlite.ts src/lore/sqlite.ts test/lore/sqlite.test.ts test/state/sqlite.test.ts
git commit -m "feat(lore): store fixed lore in sqlite"
```

---

## 任务 4：扩展 world pack loader，声明 lore 源

**文件：**
- 修改：`src/world/schema.ts`
- 修改：`src/world/loader.ts`
- 测试：`test/world/loader.test.ts`
- 修改：`worlds/_template/world.yaml`
- 创建：`worlds/_template/lore.yaml`
- 创建：`worlds/_template/lore/characters.yaml`
- 创建：`worlds/_template/lore/locations.yaml`
- 创建：`worlds/_template/lore/rules.yaml`

- [ ] **步骤 1：编写失败测试：loader 解析 lore.yaml**

```ts
test("loadWorldFromDir parses lore module", () => {
  const world = loadWorldFromDir(worldRoot);
  assert.deepEqual(world.lore.sources.map((s) => s.defaultKind), ["character"]);
  assert.ok(world.lore.sources[0]?.path.endsWith("lore/characters.yaml"));
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/world/loader.test.ts
```

- [ ] **步骤 3：实现 `WorldLoreConfig`**

```ts
export type WorldLoreSource = {
  path: string;
  defaultKind?: string;
};

export type WorldLoreConfig = {
  sources: WorldLoreSource[];
};
```

`LoadedWorld` 增加 `lore: WorldLoreConfig`。

- [ ] **步骤 4：修改 loader**

`MODULE_FIELDS` 增加 `"lore"`。新增 `parseLore(value, worldRoot)`：
- 省略 `lore` 时返回 `{ sources: [] }`，兼容旧世界。
- `sources[].path` 必须非空，解析成绝对路径。
- `sources[].default_kind` 可选，归一化为 `defaultKind`。

- [ ] **步骤 5：补模板文件**

`worlds/_template/lore.yaml`：

```yaml
version: 1
sources:
  - path: ./lore/characters.yaml
    default_kind: character
  - path: ./lore/locations.yaml
    default_kind: location
  - path: ./lore/rules.yaml
    default_kind: rule
```

- [ ] **步骤 6：运行测试验证通过**

```bash
npm test -- test/world/loader.test.ts
```

- [ ] **步骤 7：Commit**

```bash
git add src/world/schema.ts src/world/loader.ts test/world/loader.test.ts worlds/_template
git commit -m "feat(world): add lore source axis"
```

---

## 任务 5：实现 lore 导入器

**文件：**
- 创建：`src/lore/importer.ts`
- 测试：`test/lore/importer.test.ts`
- 修改：`src/runtime/bootstrap.ts`

- [ ] **步骤 1：编写失败测试：导入 YAML 源到 SQLite**

```ts
test("importWorldLore loads yaml sources into sqlite", () => {
  importWorldLore(db, {
    name: "cultivation",
    lore: { sources: [{ path: medicinesYaml, defaultKind: "medicine" }] }
  });

  const entry = getLoreEntry(db, "cultivation", "medicine.gathering-qi-pill");
  assert.equal(entry?.name, "聚气丹");
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/lore/importer.test.ts
```

- [ ] **步骤 3：实现导入器**

`importWorldLore(db, world)`：
- 遍历 `world.lore.sources`。
- 读取 YAML，支持根为数组，或 `{ entries: [...] }`。
- 对没有 `kind` 的条目填 `source.defaultKind`。
- 调用 `parseLoreEntries` 校验。
- 检查同 world 内 `id` 唯一。
- 检查 relations 的 target 若存在于本批资料则通过；target 不存在时不阻塞导入，记录为 dangling relation，避免跨世界/后续资料扩展卡死。
- 计算文件 hash，写入 `lore_sources`。
- 调用 `replaceWorldLore`。

- [ ] **步骤 4：接入 bootstrap**

在 `createRuntimeInfrastructure` 中：

```ts
const world = loadActiveWorld(projectRoot);
importWorldLore(db, world);
```

注意顺序：先 `initializeSchema(db)`，再导入 lore。

- [ ] **步骤 5：运行测试验证通过**

```bash
npm test -- test/lore/importer.test.ts test/runtime/extension-runtime.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/lore/importer.ts src/runtime/bootstrap.ts test/lore/importer.test.ts
git commit -m "feat(lore): import world lore at bootstrap"
```

---

## 任务 6：实现 SQLite 固定资料检索

**文件：**
- 创建：`src/lore/search.ts`
- 测试：`test/lore/search.test.ts`

- [ ] **步骤 1：编写失败测试：按别名、标签、多关键词命中**

```ts
test("searchLore finds entries by aliases and multi terms", () => {
  const results = searchLore(db, "cultivation", {
    query: "聚灵丹 炼气",
    kind: "medicine",
    limit: 5
  });

  assert.equal(results[0]?.id, "medicine.gathering-qi-pill");
  assert.match(results[0]?.reason ?? "", /别名|正文|标签/);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/lore/search.test.ts
```

- [ ] **步骤 3：实现归一化与打分**

规则：
- `normalizeSearchText` 做 NFKC、小写、去空格、点号、横线、括号、中英文标点。
- 精确 id：100。
- 精确 name/alias：96。
- name/alias 包含 query：92。
- kind 命中加 8 分。
- tags 全部命中：88。
- summary/body/fields 全部词命中：84。
- 部分词命中：48 到 76。
- name Levenshtein 模糊匹配：相似度乘 100。
- 最低分 52，默认最多 5 条。

- [ ] **步骤 4：实现格式化**

`formatLoreLookupResults(results)` 输出：

```md
### [medicine] 聚气丹 - medicine.gathering-qi-pill（别名精确匹配）
辅助炼气修士聚拢灵气。
```

不要输出 `body` 全文。

- [ ] **步骤 5：运行测试验证通过**

```bash
npm test -- test/lore/search.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/lore/search.ts test/lore/search.test.ts
git commit -m "feat(lore): search fixed lore entries"
```

---

## 任务 7：新增 `lookup` 与 `read_lore` 工具组

**文件：**
- 创建：`src/tools/lookup/lookup-lore.ts`
- 创建：`src/tools/lookup/read-lore.ts`
- 修改：`src/tools/registry.ts`
- 测试：`test/tools/lookup-lore.test.ts`
- 修改：`test/guards/tool-contract.test.ts`

- [ ] **步骤 1：编写失败测试：registry 注册 core.lookup**

```ts
test("world tools declaration can include core.lookup", () => {
  registerAllTools(pi, stateContext, undefined, { include: ["core.lookup"] });
  assert.ok(registeredTools.some((tool) => tool.name === "lookup"));
  assert.ok(registeredTools.some((tool) => tool.name === "read_lore"));
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/tools/lookup-lore.test.ts test/state/tools.test.ts test/guards/tool-contract.test.ts
```

- [ ] **步骤 3：实现工具**

`lookup`：
- 参数：`query` 必填，`kind` 可选，`limit` 可选。
- 使用当前 active world name 查询 SQLite。
- 返回短结果文本，details 携带 `{ results }`。

`read_lore`：
- 参数：`id` 必填。
- 读取当前 active world 的单条资料。
- 返回完整 `summary + body + fields + relations`。

工具描述必须明确：

```text
lookup 查固定世界资料；search_memory 查当前存档的历史记忆。
```

- [ ] **步骤 4：扩展 registry context**

当前 `StateToolContext` 已有 `db` 和 `stateStore`。增加 `worldName` 或直接传 `world`：

```ts
type StateToolContext = {
  db: RpDatabase;
  stateStore: StateStore;
  worldName?: string;
  ...
}
```

`extensions/core.ts` 构造 `stateContext` 时传 `world.name`。

- [ ] **步骤 5：注册 `core.lookup`**

```ts
const lookupTools = [lookupLoreTool, readLoreTool];

const builtinToolGroups = {
  "core.state": stateTools,
  "core.memory": memoryTools,
  "core.lookup": lookupTools
};
```

- [ ] **步骤 6：运行测试验证通过**

```bash
npm test -- test/tools/lookup-lore.test.ts test/state/tools.test.ts test/guards/tool-contract.test.ts
```

- [ ] **步骤 7：Commit**

```bash
git add src/tools/lookup/lookup-lore.ts src/tools/lookup/read-lore.ts src/tools/registry.ts src/tools/state/context.ts extensions/core.ts test/tools/lookup-lore.test.ts test/state/tools.test.ts test/guards/tool-contract.test.ts
git commit -m "feat(tools): add fixed lore lookup tools"
```

---

## 任务 8：补齐 GM 可见 `get_status`

**文件：**
- 创建：`src/tools/state/get-status.ts`
- 修改：`src/tools/registry.ts`
- 修改：`src/runtime/writer-tools.ts`
- 测试：`test/state/get-status.test.ts`
- 修改：`test/runtime/writer-tools.test.ts`

- [ ] **步骤 1：编写失败测试：GM 可调用 `get_status`**

```ts
test("get_status returns current GM brief", () => {
  const result = getStatusTool.execute("c1", {}, undefined, undefined, ctx);
  assert.match(resultText(result), /玩家：/);
  assert.match(resultText(result), /地点：/);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/state/get-status.test.ts test/runtime/writer-tools.test.ts
```

- [ ] **步骤 3：实现工具**

`get_status` 使用 `requireStateToolContext(ctx)`，返回 `formatStatus(stateStore.getState())`。

描述：

```text
读取当前存档状态摘要；用于确认玩家、时间、场景、属性、事实和关系。
禁区：不要用它查询固定世界资料，固定资料用 lookup；不要用它回忆旧事件，旧事件用 search_memory。
```

- [ ] **步骤 4：复用 writer get_status**

`src/runtime/writer-tools.ts` 当前有本地 `getStatusTool`。改为包装 `src/tools/state/get-status.ts`，避免 GM 和 writer 状态输出漂移。

- [ ] **步骤 5：运行测试验证通过**

```bash
npm test -- test/state/get-status.test.ts test/runtime/writer-tools.test.ts test/state/tools.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/tools/state/get-status.ts src/tools/registry.ts src/runtime/writer-tools.ts test/state/get-status.test.ts test/runtime/writer-tools.test.ts test/state/tools.test.ts
git commit -m "feat(tools): expose get_status"
```

---

## 任务 9：实现领域事件应用器，覆盖状态变化与关系变化

**文件：**
- 创建：`src/tools/state/domain-events.ts`
- 测试：`test/state/domain-events.test.ts`

- [ ] **步骤 1：编写失败测试：应用玩家状态、属性和关系事件**

```ts
test("applyDomainEvents mutates state facts and relationships", () => {
  const state = createInitialState();
  applyDomainEvents(state, [
    { kind: "player-status", status: "受伤但清醒" },
    { kind: "attribute", name: "vigor", value: 70 },
    {
      kind: "relationship",
      source: "player",
      target: "npc.han-yue",
      stance: "trusted",
      summary: "韩越信任玩家。",
      evidence: "玩家护送他离开北门。"
    }
  ], { attributeSpecs: [VIGOR] });

  assert.equal(state.player.status, "受伤但清醒");
  assert.equal(state.relationships[0]?.stance, "trusted");
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/state/domain-events.test.ts
```

- [ ] **步骤 3：定义事件 union**

第一版支持：

```ts
type DomainEvent =
  | { kind: "player-status"; status: string }
  | { kind: "location"; location: string }
  | { kind: "time"; absolute?: { day: number; hour: number }; advanceHours?: number }
  | { kind: "scene"; summary: string }
  | { kind: "attribute"; name: string; value: unknown }
  | { kind: "fact"; id?: string; factKind?: string; subject?: string; text: string; visibility?: "public" | "gm"; source?: string }
  | { kind: "relationship"; source: string; target: string; stance: string; summary: string; evidence: string; visibility?: "public" | "gm" };
```

解析入口保持 loose，核心校验严格。

- [ ] **步骤 4：实现关系 upsert 语义**

关系唯一键：`source + target`。重复关系事件覆盖 `stance/summary/evidence/visibility`，不追加重复条目。

- [ ] **步骤 5：实现 fact upsert 语义**

如果 `id` 缺省，用稳定短 hash 生成 `fact.<hash>`。重复 id 覆盖旧 fact。

- [ ] **步骤 6：复用 attribute coercion**

把 `update-attribute.ts` 的 `coerce` 抽到可复用函数，避免 `commit_turn` 和 `update_attribute` 校验不一致。

- [ ] **步骤 7：运行测试验证通过**

```bash
npm test -- test/state/domain-events.test.ts test/state/attributes.test.ts
```

- [ ] **步骤 8：Commit**

```bash
git add src/tools/state/domain-events.ts src/tools/state/update-attribute.ts test/state/domain-events.test.ts test/state/attributes.test.ts
git commit -m "feat(state): apply domain events"
```

---

## 任务 10：实现 `commit_turn` 聚合工具

**文件：**
- 创建：`src/tools/state/commit-turn.ts`
- 修改：`src/tools/registry.ts`
- 修改：`src/tools/state/submit-direction-packet.ts`
- 测试：`test/state/commit-turn.test.ts`
- 修改：`test/runtime/session-entries.test.ts`
- 修改：`test/runtime/turn-commit.test.ts`

- [ ] **步骤 1：编写失败测试：commit_turn 应用事件并返回 packet**

```ts
test("commit_turn applies domain events and submits direction packet", () => {
  initializeNewGameTool.execute("c1", {}, undefined, undefined, ctx);

  const result = commitTurnTool.execute("c2", {
    summary: "玩家救下韩越。",
    events: [{ kind: "player-status", status: "护送韩越" }],
    direction: {
      needsRender: true,
      storyElements: {
        currentSituation: "韩越靠在门边。",
        playerIntent: "玩家决定护送他。",
        visibleChanges: ["韩越开始信任玩家。"],
        presentCharacters: ["韩越"],
        characterActions: [],
        tension: "追兵接近。",
      },
      directReply: ""
    }
  }, undefined, undefined, ctx);

  assert.equal(ctx.stateStore.getState().player.status, "护送韩越");
  assert.equal(result.details?.packet.needsRender, true);
  assert.equal(result.terminate, true);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/state/commit-turn.test.ts
```

- [ ] **步骤 3：实现 `commit_turn`**

流程：
1. `requireStateToolContext(ctx)`。
2. 解析 input：`summary`、`events`、`direction`。
3. `stateStore.mutateState(draft => applyDomainEvents(draft, events, context))`。
4. `parseDirectionPacket(direction)`。
5. 返回 `done("Turn committed...", { packet, summary, eventCount })`。

注意：工具名和 runtime `commitTurn()` 函数同名不同层。必要时内部命名为 `commitTurnTool`，避免 import 混淆。

- [ ] **步骤 4：让现有 writer 链路识别新工具**

`src/runtime/session-entries.ts` 当前只找 `submit_direction_packet`。改成同时接受：

```ts
const DIRECTION_PACKET_TOOLS = new Set(["submit_direction_packet", "commit_turn"]);
```

并从 `details.packet` 提取方向包。

- [ ] **步骤 5：保留兼容**

`submit_direction_packet` 不删除。描述改成“兼容工具；新世界优先用 commit_turn”。

- [ ] **步骤 6：运行测试验证通过**

```bash
npm test -- test/state/commit-turn.test.ts test/runtime/session-entries.test.ts test/runtime/turn-commit.test.ts test/state/tools.test.ts
```

- [ ] **步骤 7：Commit**

```bash
git add src/tools/state/commit-turn.ts src/tools/registry.ts src/tools/state/submit-direction-packet.ts src/runtime/session-entries.ts test/state/commit-turn.test.ts test/runtime/session-entries.test.ts test/runtime/turn-commit.test.ts test/state/tools.test.ts
git commit -m "feat(tools): add commit_turn aggregate tool"
```

---

## 任务 11：让 writer 与子代理可读固定资料

**文件：**
- 修改：`src/runtime/writer-tools.ts`
- 测试：`test/runtime/writer-tools.test.ts`
- 修改：`src/world/materialize-subagents.ts`
- 测试：`test/world/materialize-subagents.test.ts`
- 修改：`skills/development-guide/references/world-pack.md`

- [ ] **步骤 1：编写失败测试：writer tools 包含 lookup/read_lore**

```ts
test("writer tools include fixed lore lookup", () => {
  const tools = buildWriterTools({ db, stateStore, ovClient: undefined, writingGuides: [], worldName: "demo" });
  assert.ok(tools.some((tool) => tool.name === "lookup"));
  assert.ok(tools.some((tool) => tool.name === "read_lore"));
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/runtime/writer-tools.test.ts
```

- [ ] **步骤 3：接入 writer**

`buildWriterTools` 增加 `worldName` 参数，包装 `lookup` 与 `read_lore`。writer 是只读，所以只允许 `lookup/read_lore/get_status/search_memory/read_memory/read_writing_guide`。

- [ ] **步骤 4：子代理策略**

底座不自动给所有 subagent 注入 lookup。世界作者在 `subagents.yaml` 的 `tools` 白名单中显式写 `lookup, read_lore`。文档说明：
- 需要核对世界设定的研究型/导演型子代理可给 lookup。
- 长期扮演型 role 子代理默认不给 secret lore，避免角色知道不该知道的秘密。

- [ ] **步骤 5：运行测试验证通过**

```bash
npm test -- test/runtime/writer-tools.test.ts test/world/materialize-subagents.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/runtime/writer-tools.ts test/runtime/writer-tools.test.ts src/world/materialize-subagents.ts test/world/materialize-subagents.test.ts skills/development-guide/references/world-pack.md
git commit -m "feat(writer): allow read-only lore lookup"
```

---

## 任务 12：更新世界模板与 border-station 示例

**文件：**
- 修改：`worlds/_template/tools.yaml`
- 修改：`worlds/border-station/tools.yaml`
- 修改：`worlds/border-station/world.yaml`
- 创建：`worlds/border-station/lore.yaml`
- 创建：`worlds/border-station/lore/characters.yaml`
- 创建：`worlds/border-station/lore/locations.yaml`
- 创建：`worlds/border-station/lore/background.yaml`
- 创建：`worlds/border-station/lore/rules.yaml`
- 修改：`worlds/border-station/prompts/gm-tools.md`
- 测试：`test/world/loader.test.ts`
- 测试：`test/tools/lookup-lore.test.ts`

- [ ] **步骤 1：编写失败测试：border-station 能 lookup 韩越与北门驿站**

```ts
test("border-station lore can be looked up", () => {
  const result = lookupLoreTool.execute("c1", { query: "韩越 受伤信使" }, undefined, undefined, ctx);
  assert.match(resultText(result), /韩越/);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/tools/lookup-lore.test.ts test/world/loader.test.ts
```

- [ ] **步骤 3：补世界资料**

最小条目：
- `character.han-yue`：受伤信使韩越。
- `location.border-relay`：边境驿站。
- `background.undelivered-letter`：未送达密信。
- `rule.fixed-lore-vs-memory`：固定资料与存档记忆分工。

- [ ] **步骤 4：更新工具声明**

`tools.yaml` 默认：

```yaml
include:
  - core.state
  - core.memory
  - core.lookup
extra: []
```

- [ ] **步骤 5：更新 GM 工具 prompt**

加规则：
- 固定世界资料用 `lookup/read_lore`。
- 旧存档经历用 `search_memory/read_memory`。
- 本轮状态落地优先用 `commit_turn`，旧 `update_*` 可用于调试或局部修正。

- [ ] **步骤 6：运行测试验证通过**

```bash
npm test -- test/tools/lookup-lore.test.ts test/world/loader.test.ts test/runtime/gm-prompt-assembly.test.ts
```

- [ ] **步骤 7：Commit**

```bash
git add worlds/_template worlds/border-station test/tools/lookup-lore.test.ts test/world/loader.test.ts
git commit -m "feat(world): add fixed lore examples"
```

---

## 任务 13：补文档与开发指南

**文件：**
- 修改：`README.md`
- 修改：`skills/development-guide/references/world-pack.md`
- 修改：`docs/design/openviking-mvp.md`
- 创建：`docs/design/lore-lookup.md`

- [ ] **步骤 1：编写文档草案**

`docs/design/lore-lookup.md` 必须说明：
- 固定资料、当前状态、长期记忆三者分工。
- `lore.yaml` 和 `lore/*.yaml` 示例。
- `lookup` 与 `search_memory` 的选择规则。
- visibility 的含义。
- 为什么 SQLite 是运行索引，源文件才是编辑入口。

- [ ] **步骤 2：更新 world-pack 指南**

加入目录：

```text
├── lore.yaml
└── lore/
    ├── characters.yaml
    ├── locations.yaml
    └── rules.yaml
```

- [ ] **步骤 3：更新 README 快速说明**

补一句：世界固定资料写在 `lore/`，启动时导入 SQLite，GM 用 `lookup/read_lore` 查询。

- [ ] **步骤 4：运行文档相关测试**

```bash
npm test -- test/world/loader.test.ts test/scripts/smoke-demo.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add README.md skills/development-guide/references/world-pack.md docs/design/openviking-mvp.md docs/design/lore-lookup.md
git commit -m "docs: document fixed lore lookup"
```

---

## 任务 14：全量验证

**文件：**
- 修改：按失败结果修正相关文件。

- [ ] **步骤 1：类型检查**

```bash
npm run typecheck
```

预期：通过。

- [ ] **步骤 2：全量测试**

```bash
npm test
```

预期：全部通过。

- [ ] **步骤 3：smoke**

```bash
bash scripts/smoke-demo.sh
```

预期：
- typecheck 通过。
- node test 通过。
- OpenViking 不可达时安全 SKIP。
- OpenViking 可达时 memory smoke 通过。

- [ ] **步骤 4：人工运行验证**

```bash
RP_WORLD=border-station ./start.sh
```

在 TUI 中输入：

```text
查询韩越是谁，并开始新游戏。
```

预期：
- GM 能调用 `lookup` 查韩越固定设定。
- GM 调 `initialize_new_game` 或 `commit_turn` 落初始状态。
- 可渲染回合最终通过 writer 输出正文。

- [ ] **步骤 5：Commit**

```bash
git status --short
git add .
git commit -m "test: verify lore lookup and domain tools"
```

---

## 风险与裁剪

| 风险 | 处理 |
| --- | --- |
| 范围过大 | 先实现 YAML 源，不做 Markdown frontmatter 编辑器 |
| 中文分词复杂 | 第一版用 normalization + n-gram/token 包含匹配，不引入外部搜索库 |
| visibility 误用 | 第一版工具只按 `public/gm/secret` 过滤；角色知识边界由 prompt 和 subagent 白名单补充 |
| `commit_turn` 与旧工具并存导致混乱 | prompt 优先 `commit_turn`，旧工具保留为兼容和局部修正 |
| SQLite lore 与 save state 混淆 | lore 表按 `world_name` 隔离，不带 `save_id` |

## 验收标准

- `lookup` 能查本地 SQLite 固定资料，且不依赖 OpenViking。
- `read_lore` 能按 id 读完整固定资料。
- `search_memory/read_memory` 仍只查当前 save 的 OV 长期记忆。
- `get_status` 同时给 GM 和 writer 使用，输出当前状态、事实和关系。
- `commit_turn` 能一次应用状态变化、关系变化，并提交 writer 方向包。
- 世界作者只改 `worlds/<name>/lore*.yaml` 就能增加人物、地点、背景、等级、丹药等固定设定。
- `npm run typecheck` 与 `npm test` 通过。
