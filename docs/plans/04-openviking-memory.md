# 阶段 4：OpenViking 记忆接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 接入真实 OpenViking：成功回合后异步提交玩家输入 + writer 正文；GM 可 `search_memory` / `read_memory`；启用 RP 自定义 `characters` 和 `story_events` schema。

**架构：** OV 是最终一致长期记忆层。GM 不写 OV；hook 自动 append/commit；每个 save 独立 user space 和 OV session；检索范围固定当前 save memory root。

**技术栈：** TypeScript HTTP client、OpenViking HTTP API、Markdown/YAML memory schema、node:test。

---

## 文件结构

创建：

```text
src/ov/client.ts
src/ov/config.ts
src/ov/session-binding.ts
src/ov/turn-memory-hook.ts
src/ov/search-tools.ts
src/ov/uri.ts
openviking/memory/characters.yaml
openviking/memory/story_events.yaml
src/tools/lookup/search-memory.ts
src/tools/lookup/read-memory.ts
test/ov/client.test.ts
test/ov/uri.test.ts
test/ov/tools.test.ts
```

修改：

```text
src/tools/registry.ts
extension.ts
src/state/save-repository.ts
```

## OV 行为约束

- 每个 save 的 `user_space = save-{uuid}`。
- 每个 save 一个长期 `ov_session_id`。
- `commit keep_recent_count=0 wait=false`。
- 不记录 `task_id` 到 SQLite。
- 只提交：
  - 玩家输入，role=`user`
  - writer 正文，role=`assistant`
- GM 只拥有：
  - `search_memory(query, limit?)`
  - `read_memory(uri)`

## 任务 1：OV config 与 URI

- [ ] **步骤 1：写失败测试**

验证：

- `save_id` 转成 `save-{uuid}` user space。
- memory root 为 `viking://user/save-{uuid}/memories`。
- `read_memory` 只允许当前 save root 下 URI。

- [ ] **步骤 2：实现 `src/ov/config.ts`**

读取：

```text
OPENVIKING_URL
OPENVIKING_API_KEY
OPENVIKING_ACCOUNT
```

- [ ] **步骤 3：实现 `src/ov/uri.ts`**

导出：

```ts
userSpaceForSave(saveId)
memoryRootForSave(saveId)
assertUriInCurrentSave(uri, saveId)
```

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/ov/uri.test.ts
npm run typecheck
```

预期：PASS。

## 任务 2：OV HTTP client

- [ ] **步骤 1：写失败测试**

用 mock fetch 验证：

- headers 包含 API key、account、user。
- add message 请求路径正确。
- commit 请求发送 `keep_recent_count=0`。
- search/read 解析返回。

- [ ] **步骤 2：实现 `src/ov/client.ts`**

封装端点：

```ts
ensureSession(sessionId)
addSessionMessage(sessionId, role, content)
commitSession(sessionId, { keepRecentCount: 0 })
find(query, targetUri, limit)
read(uri)
```

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/ov/client.test.ts
npm run typecheck
```

预期：PASS。

## 任务 3：Save -> OV session 绑定

- [ ] **步骤 1：扩展 SQLite schema**

在 `saves` 或新增表中保存 `ov_session_id`。推荐新增表：

```sql
ov_session_bindings(save_id, ov_session_id, updated_at)
```

注意：不保存 `task_id`。

- [ ] **步骤 2：写失败测试**

验证：

- 新 save 创建 OV session id。
- 已存在 save 复用同一个 OV session id。

- [ ] **步骤 3：实现 `src/ov/session-binding.ts`**

导出：

```ts
getOrCreateOvSessionForSave(saveId)
```

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/ov/*.test.ts
npm run typecheck
```

预期：PASS。

## 任务 4：Turn memory hook

- [ ] **步骤 1：写失败测试**

验证：

- writer 成功正文后 append 两条消息。
- writer 失败不提交。
- `needsRender=false` 不提交。
- commit 使用 `wait=false` 语义，不等待 task。
- task_id 只进 logger，不落 SQLite。

- [ ] **步骤 2：实现 `src/ov/turn-memory-hook.ts`**

输入：

```ts
saveId
playerInput
writerProse
```

行为：

```text
get ov session
append user
append assistant
commit keep_recent_count=0
```

- [ ] **步骤 3：接入 `turn-commit.ts`**

writer prose custom message 和 story snapshot 成功后触发 OV hook。

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/ov/*.test.ts test/runtime/*.test.ts
npm run typecheck
```

预期：PASS。

## 任务 5：GM memory read tools

- [ ] **步骤 1：写失败测试**

验证：

- `search_memory` 固定 target_uri 为当前 save root。
- `search_memory` 返回 URI、abstract、score。
- `read_memory` 拒绝跨 save URI。
- `read_memory` 返回 Markdown 正文。

- [ ] **步骤 2：实现工具**

`src/tools/lookup/search-memory.ts`：

```text
参数：query, limit?
```

`src/tools/lookup/read-memory.ts`：

```text
参数：uri
```

- [ ] **步骤 3：注册工具**

修改 `src/tools/registry.ts`。

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/ov/tools.test.ts
npm run typecheck
```

预期：PASS。

## 任务 6：自定义 memory schema

- [ ] **步骤 1：创建 `characters.yaml`**

路径：

```text
viking://user/{{ user_space }}/memories/characters/{{ name }}.md
```

规则：

- 中文内容。
- 单角色单文件 upsert。
- 只提取明确出现或提到的角色。
- 不创建模糊群体。
- 不存原文摘录。

- [ ] **步骤 2：创建 `story_events.yaml`**

路径：

```text
viking://user/{{ user_space }}/memories/story_events/{{ extract_context.get_year(ranges) }}/{{ extract_context.get_month(ranges) }}/{{ event_name }}.md
```

规则：

- 中文内容。
- `operation_mode: add_only`。
- 现实消息时间。
- 摘要 + writer 正文短摘录。
- Source 不摘玩家输入。

- [ ] **步骤 3：写 OV 配置说明**

在 README 或 config 示例中说明：

```text
memory.custom_templates_dir = ./openviking/memory
memory_policy.memory_types = characters, story_events
```

实际配置字段以 OV 当前配置为准，若 API 支持 per-session memory_policy，优先在 create/commit session 时设置。

## 阶段验收

- [ ] OV client 单测通过。
- [ ] URI 隔离测试通过。
- [ ] 成功回合后只提交玩家输入 + writer 正文。
- [ ] GM 没有 OV 写工具。
- [ ] 自定义 schema 文件存在。
- [ ] 默认长期 memory schema 在 MVP 提取策略中被排除。
