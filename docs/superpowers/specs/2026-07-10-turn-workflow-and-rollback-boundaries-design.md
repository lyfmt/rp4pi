# 回合工作流与回退边界设计

**状态：** 已确认  
**日期：** 2026-07-10

## 目的

本设计只固定两件事：RP 回合工作流的语义，以及本次回退需要保留和删除的能力边界。
新的系统扩展接口不在本文中设计；它必须在干净基线上另开规格。

## 术语

| 术语 | 定义 |
| --- | --- |
| 用户交互 | 玩家或用户发出的一条输入，以及 GM 对该输入的处理过程 |
| GM 流程 | GM 为处理当前输入而进行的读取、裁定、调用工具和状态推进 |
| `commit_turn` | GM 内部的状态推进动作；同一次 GM 流程中允许调用多次 |
| `submit_direction_packet` | GM 将叙事材料交给 writer，或直接回复用户的展示动作 |
| 故事回合 | 一次成功生成并交付玩家可见正文的 in-world 回合 |
| story snapshot | 成功故事回合对应的完整状态检查点，是 `/roll` 的回退边界 |

## 已确认语义

### `commit_turn`

- 服务于 GM 自己的流程推进，不是玩家可见内容的提交。
- 同一次 GM 流程可以调用多次，所有推进累积到当前存档状态。
- 不携带 direction packet。
- 不调用 writer。
- 不终止 GM 工具循环。
- writer 或正文生成失败时，已经完成的状态推进仍然有效。
- 它未来如何接收不同系统的状态操作，留给新的扩展接口规格决定。

### `submit_direction_packet`

- 只负责展示层交接，不负责状态推进。
- `needsRender=true` 时终止 GM 流程并交给 writer 生成玩家可见正文。
- 正文成功交付后记录 story snapshot。
- `needsRender=false` 时用于 OOC、询问或其他直接回复，不记录 story snapshot，也不推进故事回合。

### `/roll`

- 面向故事回合，而不是某一次内部 `commit_turn`。
- 恢复到被重跑的玩家输入之前的 story snapshot。
- 撤销该故事回合内累积的全部 GM 状态推进。
- 恢复后重跑相应玩家输入。
- OOC 直接回复不创建 story snapshot；OOC 后调用 `/roll` 的特殊交互不在本次回退范围内重新定义。

## 标准链路

### 可渲染故事回合

```text
玩家输入
-> GM 读取状态、资料和记忆
-> GM 裁定并按需多次 commit_turn
-> GM 调用 submit_direction_packet(needsRender=true)
-> GM 工具循环结束
-> writer 生成并交付正文
-> 记录 story snapshot
```

### OOC 或直接回答

```text
用户询问
-> GM 调用 submit_direction_packet(needsRender=false)
-> 直接回复
-> 不记录 story snapshot
```

### writer 失败

```text
GM 已完成若干 commit_turn
-> submit_direction_packet(needsRender=true)
-> writer 失败
-> 已推进的当前状态保留
-> 不记录成功故事回合的 snapshot
```

## 回退后保留的能力

- world pack 加载与声明式模块。
- SQLite save、latest state、story snapshot、`/save`、`/load`、`/roll`。
- GM -> direction packet -> writer 两段式正文链路。
- `submit_direction_packet` 的 render/direct-reply 两种展示模式。
- OpenViking 记忆集成。
- 固定 lore 的导入、查询和 writer 只读访问。
- `get_status` 与现有单字段 `update_*` 状态工具。
- 手动 subagent、角色轨迹、已有 hooks、writing 和 revision。

## 回退时删除的能力

- 当前把 events、direction 和终止行为聚合在一起的 `commit_turn` 实现。
- 中央 `DomainEvent` parser 和统一事件写入协议。
- mechanism state slot、manifest 轴、registry、reducer、工具和状态投影。
- domain command runner、append-only event ledger 和统一 projection engine。
- domain jobs/scheduler、自动 subagent invocation、统一 RNG 和 entity registry。
- 强制世界作者遵循上述统一模型的技能、文档和世界提示词。

## 非目标

- 本次回退不实现新的 `commit_turn`。
- 本次回退不决定系统模块使用 reducer、command、直接事务还是其他状态模型。
- 本次回退不决定审计、RNG、job、projection 是否作为可选能力重新加入。
- 本次回退不删除旧分支或历史；旧实现保留为只读参考。

## 回退验收

1. 运行时不再注册当前聚合式 `commit_turn`。
2. `submit_direction_packet` 是唯一会产生 direction packet 并终止 GM 的工具。
3. `needsRender=true` 的成功正文继续记录 story snapshot。
4. `needsRender=false` 继续不记录 story snapshot。
5. `/roll`、writer、memory、lore、hooks 和手动 subagent 的既有测试通过。
6. 源码中不存在 mechanism/domain runtime foundation 的实现。
7. 面向 GM 和世界作者的活动文档不再教授旧的聚合式 `commit_turn` 协议。

