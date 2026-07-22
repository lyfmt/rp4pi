# OpenViking MVP Integration Design

本文记录 RP Agent Scaffold MVP 中 OpenViking（OV）记忆层的已确认设计。

## 结论

MVP 使用真实 OpenViking 作为长期记忆层。

SQLite/state 负责确定性世界状态；OpenViking 负责从成功回合中异步沉淀长期语义记忆。OV 不承担强一致状态职责。

## 写入边界

GM 不直接写 OV。

OV 写入只由 turn 成功后的 hook 自动触发：

```text
玩家输入
-> GM 按需用现有 `update_*` 工具推进确定性状态
-> GM 用 `submit_direction_packet` 提交 direction packet
-> writer 成功生成正文
-> 正文展示为 custom-message
-> 记录 SQLite story snapshot
-> hook append 玩家输入 + writer 正文 到 OV session
-> hook commit OV session
-> OV extractor 异步沉淀记忆
```

提交给 OV 的内容只包含：

- 玩家输入，role 为 `user`
- writer 正文，role 为 `assistant`

不提交：

- GM direction packet
- GM 工具调用
- SQLite state diff
- GM 内部过程
- 失败重试内容

## Session 与隔离

每个 save 使用独立 OV user space：

```text
save_id = uuid
user_space = save-{uuid}
memory_root = viking://user/save-{uuid}/memories
```

每个 save 仍绑定一个长期 OV session，但 session 不作为隔离边界，只作为 append/commit 的消息队列和归档容器。

每个成功回合：

```text
append user message
append assistant writer prose
commit keep_recent_count=0
```

`keep_recent_count=0`，避免旧 live messages 在下一次 commit 中重复提取。

## 异步一致性

commit 使用异步模式：

```text
wait=false
```

OV 的实现中，commit Phase 1 同步完成归档，Phase 2 在后台执行 archive summary、memory extraction 和 vectorize。

MVP 不等待 Phase 2 完成，也不记录 `task_id` 到 SQLite。`task_id` 只允许写日志。

因此：

- 下一回合检索不保证能搜到上一回合刚沉淀的记忆。
- 确定性连续性只能依赖 pi session + SQLite/state。
- OV 是最终一致的长期辅助记忆层。

## GM 读取能力

GM 只拥有 OV 读取工具：

```text
search_memory(query, limit?)
read_memory(uri)
```

不提供：

```text
write_memory
commit_turn_memory
delete_memory
list_memory
```

`search_memory` 内部固定当前 save 的检索范围：

```text
target_uri = viking://user/save-{uuid}/memories
context_type = memory
```

GM 自行判断何时检索。系统不自动注入 OV 召回结果。

工具提示原则：

```text
当玩家提到当前存档里的旧人物、旧地点、旧承诺、长期目标、模糊回忆时，先 search_memory。
固定世界设定不要查 search_memory，使用 lookup/read_lore。
搜索结果只有摘要；需要细节时 read_memory。
不要每回合无脑搜索。
```

## 检索返回

`search/find` 返回 URI、摘要和分数，不返回完整 Markdown：

```json
{
  "memories": [
    {
      "uri": "viking://user/save-xxx/memories/characters/alice.md",
      "abstract": "Alice ...",
      "score": 0.82
    }
  ],
  "resources": [],
  "skills": [],
  "total": 1
}
```

GM 需要全文时调用 `read_memory(uri)`，返回可见 Markdown 正文。

## 自定义 Memory Schema

MVP 禁用默认长期记忆 schema，只启用两个 RP schema：

```text
characters
story_events
```

原因：OV 默认 `profile/preferences/entities/events` 偏用户记忆和真实世界事件，容易把 RP 内容误归类。

记忆内容统一中文。角色名保留原文，不强行翻译。

### characters

角色记忆按角色名单文件持续更新：

```text
viking://user/{{ user_space }}/memories/characters/{{ name }}.md
```

写入模式：

```text
operation_mode = upsert
```

语义规则：

- 只提取玩家输入或 writer 正文中明确出现、明确提到的角色。
- 不创造未出现角色。
- 不为模糊群体创建角色记忆，例如守卫、村民、敌人。
- 可以记录角色当前状态，但必须来自正文明确表达。
- 不存原文摘录，只存结构化当前信息。

推荐内容结构：

```markdown
# 角色名

## Current State
- ...

## Known Facts
- ...

## Relationships
- ...

## Recent Changes
- ...
```

### story_events

剧情事件按现实消息时间分目录，只新增，不更新旧事件：

```text
viking://user/{{ user_space }}/memories/story_events/YYYY/MM/{{ event_name }}.md
```

写入模式：

```text
operation_mode = add_only
```

时间来源使用现实消息时间，不使用游戏内时间。

内容只存摘要和短摘录，不存整段正文。`Source` 只摘 writer 正文；玩家输入只作为 extractor 判断事件的上下文，不进入事件原文摘录。

推荐内容结构：

```markdown
# 事件名

## Summary
- ...

## Source
- writer 正文中的 1-3 句关键摘录
```

## 与 SQLite 的分工

SQLite/state 负责：

- 玩家状态
- 玩家位置
- 游戏时间
- 当前场景
- 回退与 roll
- 最新可恢复状态

SQLite/lore index 负责：

- 固定人物、地点、背景、规则等世界权威资料的只读索引
- `lookup` / `read_lore` 的本地检索
- 从世界包 `lore.yaml` / `lore/*.yaml` 启动导入

OpenViking 负责：

- 长期角色记忆
- 剧情事件时间线
- 语义检索
- Markdown 记忆文件、abstract、overview、向量索引

确定性修正不走 OV，仍由 SQLite/state 兜底。
