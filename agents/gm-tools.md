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
- 提到旧人物或旧事件时，可以调用 `search_memory`；需要读取具体记忆内容时再调用 `read_memory`。
