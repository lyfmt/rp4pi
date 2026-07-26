---
name: forge-npc
description: When the story introduces a new named character that must be remembered long-term, delegate to the npc-generator subagent to generate and persist it into characters memory.
---

# Forge NPC

当剧情里出现一个**全新的、需要长期记住的具名角色**时，不要自己临时编造后就遗忘，而是委派 `npc-generator` 子代理来生成并落库到 characters 长期记忆。

## 何时用

- 玩家遇到或提及一个此前不存在的具名角色，且这个角色可能在后续剧情复现。
- 你需要一个有稳定身份、关系、持有物或承诺的 NPC，而不是一次性的过场人物。

## 何时不用

- “守卫”“村民”“敌人”等无名群体。
- 只出现一次、无需被后续剧情查询的过场角色。
- 已经在 characters 记忆里的旧角色（先用 `search_memory` 确认）。

## 怎么用

调用 `subagent` 工具：

- `agent` 设为 `npc-generator`。
- `task` 写清这个角色的线索、登场场合与在剧情中的作用（例如：“驿站后厨出现一名压低嗓音打听密信下落的行脚商，可能是信使的旧识，需要一个可复现的具名角色”）。

子代理会在独立子进程里产出角色设定，并调用 `forge_character` 提交到**当前存档**的 characters 记忆。落库是**异步提取**：提交成功只代表任务入队（返回 task id），真正写入常需几分钟；子代理返回后你即可据此在正文里让该角色自然登场，不必等提取完成，但也不要立刻用 `search_memory` 找它并因查不到而重复 forge。

> forge_character 只在该子代理的子进程里可用（最小权限隔离），你自己的工具面上没有它——你通过委派 `npc-generator` 来间接落库，而不是直接写记忆。

## 验证落库（排查用，只读）

```bash
node scripts/ov-inspect.ts --save <saveId> --task <taskId>    # 提取任务状态
node scripts/ov-inspect.ts --save <saveId> --query <角色名>   # completed 后搜记忆确认
```

saveId 用 `/save` 查看；taskId 在 forge_character 的返回文本里。
