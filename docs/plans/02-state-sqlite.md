# 阶段 2：SQLite 与 State 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 MVP 的 hot state、SQLite save 分离、latest_state、成功回合 snapshot 和 state mutation tools。

**架构：** state 在进程内常驻；所有状态变化必须通过 narrow tools；工具变更 hot state 后立即写 `latest_states`。成功故事回合 snapshot 在 writer 成功后由 runtime 阶段写入，不在本阶段完成。

**技术栈：** TypeScript、Node 24 `node:sqlite`、node:test。

---

## 文件结构

创建：

```text
src/state/schema.ts
src/state/store.ts
src/state/sqlite.ts
src/state/save-repository.ts
src/state/session-binding.ts
src/state/snapshots.ts
src/state/status.ts
src/tools/state/initialize-new-game.ts
src/tools/state/update-location.ts
src/tools/state/update-player-status.ts
src/tools/state/update-time.ts
src/tools/state/update-scene.ts
test/state/sqlite.test.ts
test/state/tools.test.ts
```

修改：

```text
src/tools/registry.ts
```

## 数据模型

State：

```json
{
  "player": {
    "name": "",
    "status": "",
    "location": ""
  },
  "time": {
    "day": 1,
    "hour": 8
  },
  "scene": {
    "summary": ""
  }
}
```

SQLite 表：

```sql
saves(id, created_at, updated_at)
session_bindings(pi_session_id, save_id, updated_at)
latest_states(save_id, state_json, updated_at)
turn_snapshots(save_id, turn_no, state_json, created_at)
```

## 任务 1：State 类型与校验

- [ ] **步骤 1：写失败测试**

`test/state/tools.test.ts` 验证：

- 初始 state 有默认字段。
- `formatStatus` 输出玩家、状态、地点、时间、场景。

- [ ] **步骤 2：实现 `src/state/schema.ts`**

导出：

```ts
export type RpState = ...
export function createInitialState(input): RpState
export function parseState(value: unknown): RpState
```

- [ ] **步骤 3：实现 `src/state/status.ts`**

导出：

```ts
export function formatStatus(state: RpState): string
```

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/state/tools.test.ts
npm run typecheck
```

预期：PASS。

## 任务 2：SQLite schema 与 repository

- [ ] **步骤 1：写失败测试**

`test/state/sqlite.test.ts` 使用 `/tmp` 临时数据库，验证：

- 初始化建表。
- 创建 save。
- 写入/读取 latest_state。
- save_id 隔离。

- [ ] **步骤 2：实现 `src/state/sqlite.ts`**

使用 Node 24 `node:sqlite`，提供：

```ts
openRpDatabase(path: string)
initializeSchema(db)
```

- [ ] **步骤 3：实现 repository**

`src/state/save-repository.ts`：

```ts
createSave()
touchSave()
listSaves()
```

`src/state/session-binding.ts`：

```ts
bindSessionToSave(piSessionId, saveId)
getBoundSave(piSessionId)
```

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/state/sqlite.test.ts
npm run typecheck
```

预期：PASS。

## 任务 3：Hot state store

- [ ] **步骤 1：写失败测试**

验证：

- hydrate 从 latest_state 恢复。
- mutating update 立即 persist latest_state。
- 不同 save hydrate 不串。

- [ ] **步骤 2：实现 `src/state/store.ts`**

导出：

```ts
hydrateSave(saveId)
getState()
replaceState(saveId, state)
mutateState(mutator)
getActiveSaveId()
```

规则：

- store 内有当前 active save。
- `mutateState` clone draft，成功后 commit。
- 失败不提交。
- 每次 commit 立即写 `latest_states`。

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/state/sqlite.test.ts
npm run typecheck
```

预期：PASS。

## 任务 4：State tools

- [ ] **步骤 1：写工具测试**

验证：

- `initialize_new_game` 创建随机 UUID save 并初始化 state。
- `update_location` 只改 `player.location`。
- `update_player_status` 只改 `player.status`。
- `update_time` 支持 absolute 或 relative，二者互斥。
- `update_scene` 只改 `scene.summary`。

- [ ] **步骤 2：实现工具文件**

每个工具契约与实现同文件，参数 schema 简洁，入口做 unknown -> typed input。

- [ ] **步骤 3：注册工具**

修改 `src/tools/registry.ts`，注册 5 个 state tools。

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/state/tools.test.ts
npm run typecheck
```

预期：PASS。

## 任务 5：Snapshot helper

- [ ] **步骤 1：写失败测试**

验证：

- 成功 story snapshot 递增 per-save `turn_no`。
- 每个 save 只保留最新 2 个 snapshot。
- `loadPreviousSnapshot` 返回上一轮成功 story snapshot。

- [ ] **步骤 2：实现 `src/state/snapshots.ts`**

导出：

```ts
recordSuccessfulStorySnapshot(saveId, state)
loadPreviousStorySnapshot(saveId)
```

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/state/sqlite.test.ts
npm run typecheck
```

预期：PASS。

## 阶段验收

- [ ] `npm test -- test/state/sqlite.test.ts test/state/tools.test.ts` 通过。
- [ ] `npm run typecheck` 通过。
- [ ] 没有通用 `update_state` / `patch_state` 常规工具。
- [ ] 所有 state mutation tool 都立即写 `latest_state`。
