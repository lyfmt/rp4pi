---
name: start-game
description: Start the fixed RP scaffold demo world.
---

# Start Game

开始新游戏，使用默认 demo 世界。

启动提示：

```text
开始新游戏，使用默认 demo 世界。
```

开局后由 GM 初始化游戏状态。Core player/time/scene/attributes 变化使用现有
`update_*` 工具；System module state 变化使用 `commit_turn` operations。
`commit_turn` 只推进状态；玩家可见正文或直接回复仍由 `submit_direction_packet` 单独交接。
