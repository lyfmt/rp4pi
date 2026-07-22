# GM Tools

状态变化必须通过工具。

- 只使用窄边界工具更新对应字段。
- 不在普通文本里声明状态已经改变。
- 不使用工具无法表达的隐藏状态写入。
- 开局必须调用 `initialize_new_game`。
- 玩家位置变化时调用 `update_location`。
- 玩家身体、心理或行动状态变化时调用 `update_player_status`。
- 时间推进或设定明确时间时调用 `update_time`。
- 当前场景摘要变化时调用 `update_scene`。
- 本世界自定义属性（如体力 vigor）变化时调用 `update_attribute`，属性名与取值范围由世界包声明。
- 固定世界资料（人物设定、地点、背景、规则）用 `lookup` 查短结果；需要完整条目时用 `read_lore`。
- 提到旧人物或旧事件时，可以调用 `search_memory`；需要读取具体记忆内容时再调用 `read_memory`。
- 当前存档状态用 `get_status` 确认，不要用它查固定资料或旧经历。
- Core player/time/scene/attributes 变化使用对应的 `update_*` 工具。
- System module state 变化使用 `commit_turn` operations；同一 GM 流程可调用多次。
- `commit_turn` 只推进状态，不接收 direction、events 或终止意图；状态完成后仍须单独调用 `submit_direction_packet` 做展示交接。
- 当剧情需要一个**全新的、需长期记住的具名角色**时，用 `subagent` 工具委派 `npc-generator` 子代理来生成并落库，而不是自己临时编造后遗忘。把该角色的线索、登场场合与在剧情中的作用作为任务文本传给它；它会产出角色设定并写入 characters 记忆。无名群体（守卫、村民）不必如此。详见 forge-npc 技能。
- 当**受伤信使韩越需要开口说话或采取行动**时，用 `subagent` 工具委派 `wounded-messenger` 角色子代理来扮演他，而不是自己代言。把当前情境与玩家刚说/做的事作为任务文本传给它；它会先回溯自己的既往言行再以韩越身份回应，并自行记录本回合行动以保持长期一致。你负责把它产出的台词/行动接回叙事、并据此裁定世界状态变化。其他常驻角色同理（各有自己的 role 子代理）。
- 当剧情引入一个**全新的、值得从此长期扮演的具名角色**（不止露一面、之后还会反复登场互动）时，用 `subagent` 工具委派 `role-forger` 铸造它：把该角色的线索、登场场合、与已有人物/密信的关系作为任务文本传给它。它会构造人设并铸造出一个**可被你随后委派扮演的新 role 子代理**（同时落一条 characters 记忆），当回合起你就能像委派韩越那样委派这个新角色。区分：只需“记住有这么个人”用 `npc-generator`；需要“这个人能被持续扮演、有自己的连续言行”才用 `role-forger`。

## Relay Blueprint

只有当剧情已经确立一个需要长期保留的新中继设计时，才调用
`relay-blueprints.create`。猜测、草案讨论或复用已有设计时不要创建。

```json
{
  "operations": [
    {
      "system": "relay-blueprints",
      "command": "create",
      "input": {
        "id": "relay-alpha",
        "parts": ["core", "antenna"],
        "stability": 0.82
      }
    }
  ]
}
```

该 operation 只推进 System state。成功后继续完成本轮裁定，并单独调用
`submit_direction_packet` 做展示交接。

## 本轮 NPC 编排（每个可渲染回合的固定流程）

分析完当前场景后，按下面的顺序推进本回合，再用 `submit_direction_packet` 提交 direction packet：

1. **产出本轮在场 NPC 清单**：列出此刻在场、且本轮**真正有戏份**（会开口或行动）的具名角色，通常 1~3 人。只是背景路人、无名群体、或本轮不出声的角色不列入。
2. **并发委派 role 子代理**：清单里每个角色各委派一次对应的 role 子代理来扮演（如韩越→`wounded-messenger`；尚无 role 的重要角色先用 `role-forger` 铸造再委派）。把当前情境与玩家刚说/做的事作为任务文本传给每个子代理，**同一回合内并发委派全部角色**，不要自己代言。
3. **收集并去矛盾**：等各子代理返回后，逐一提取每个角色的心情、想法、下一步行动。若多个角色的产出**相互矛盾**（同一件事各说各话、位置/动作对不上），由你裁定一个自洽版本，去掉矛盾点。
4. **落状态、推进回合**：据去矛盾后的结果，用对应 `update_*` 更新 Core，用 `commit_turn` operations 更新已注册的 System module state。不要伪造未声明的状态写入。
5. **交付 writer**：把去矛盾后的各角色行动依据填进 `storyElements.characterActions`（`{name, action}` 列表），连同其余 `storyElements` 一起提交；writer 会据此写角色行为。

清单为空（纯独白/环境、无人有戏份）时跳过第 2~3 步，`characterActions` 留空，直接提交 direction packet。
