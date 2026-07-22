# 阶段 5：Slash Commands 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 MVP 玩家工具：`/status`、`/save`、`/load`、`/roll`。

**架构：** Slash commands 只操作当前 pi session 绑定的 save。`/load` 改当前 pi session 对应 save，不改 pi session history。`/roll` 回到上一成功 story snapshot，然后使用当前 pi session 最新 user message 重新走 GM -> writer -> commit。

**技术栈：** TypeScript、pi slash command API、SQLite state store。

---

## 文件结构

创建：

```text
src/commands/status.ts
src/commands/save.ts
src/commands/load.ts
src/commands/roll.ts
src/commands/registry.ts
src/commands/picker.ts
test/commands/status.test.ts
test/commands/load.test.ts
test/commands/roll.test.ts
```

修改：

```text
extension.ts
src/state/session-binding.ts
src/runtime/turn-commit.ts
```

## 命令合同

### `/status`

输出：

```text
玩家：<name>
状态：<player.status>
地点：<player.location>
时间：第 <day> 天 <hour>:00
场景：<scene.summary>
```

### `/save`

- 保存当前 active save。
- 输出 save id。
- 不输出 status。

### `/load`

- 交互式 save picker。
- 10 条一页。
- 显示 `updated_at | save_id`。
- 成功后改当前 pi session save binding。
- hydrate `latest_state`。
- 输出 status。

### `/roll`

- 当前 save 内回退。
- 加载上一成功 story snapshot。
- 用当前 pi session 最新 user message 重新跑 GM -> writer -> commit。
- 不跨 save。

## 任务 1：Command registry

- [ ] **步骤 1：创建 `src/commands/registry.ts`**

导出：

```ts
registerAllCommands(pi)
```

- [ ] **步骤 2：接入 `extension.ts`**

extension 只调用注册函数，不内联实现。

- [ ] **步骤 3：运行类型检查**

```bash
npm run typecheck
```

预期：PASS。

## 任务 2：`/status`

- [ ] **步骤 1：写失败测试**

验证输出格式严格匹配。

- [ ] **步骤 2：实现 `src/commands/status.ts`**

读取当前 state，调用 `formatStatus`。

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/commands/status.test.ts
npm run typecheck
```

预期：PASS。

## 任务 3：`/save`

- [ ] **步骤 1：写失败测试**

验证：

- 当前 save updated_at 被刷新。
- 输出包含 save id。
- 不包含完整 status。

- [ ] **步骤 2：实现 `src/commands/save.ts`**

调用 repository `touchSave`。

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/commands/status.test.ts
npm run typecheck
```

预期：PASS。

## 任务 4：`/load`

- [ ] **步骤 1：写 picker 单测**

验证：

- saves 按 `updated_at` 倒序。
- 10 条一页。
- numbered fallback 能选择 save。

- [ ] **步骤 2：实现 `src/commands/picker.ts`**

优先 pi native picker；若没有则编号 fallback。

- [ ] **步骤 3：实现 `src/commands/load.ts`**

行为：

```text
list saves
pick save
bind current pi_session_id -> save_id
hydrate latest_state
print status
```

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/commands/load.test.ts
npm run typecheck
```

预期：PASS。

## 任务 5：`/roll`

- [ ] **步骤 1：写失败测试**

验证：

- 没有 previous snapshot 时返回可读错误。
- 有 snapshot 时 replace current state。
- 不改变 save id。
- 使用 latest user message 重新进入 turn runtime。

- [ ] **步骤 2：实现 latest user message adapter**

若真实 pi API 尚不明确，先定义接口：

```ts
getLatestUserMessage(piSession): string | null
```

- [ ] **步骤 3：实现 `src/commands/roll.ts`**

行为：

```text
loadPreviousStorySnapshot
replaceState
rerunTurn(latestUserMessage)
```

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/commands/roll.test.ts
npm run typecheck
```

预期：PASS。

## 阶段验收

- [ ] `/status` 格式符合设计。
- [ ] `/save` 只输出 save id。
- [ ] `/load` picker 可用，加载后输出 status。
- [ ] `/roll` 当前 save 内工作，不跨 save。
- [ ] 全部 commands 测试与 typecheck 通过。
