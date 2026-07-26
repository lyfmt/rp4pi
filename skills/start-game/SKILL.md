---
name: start-game
description: Start a new game in the currently loaded world pack.
---

# Start Game

开始新游戏。玩什么世界在**启动时**就已定死：`RP_WORLD=<name> ./start.sh` 指定，
不指定则取 `worlds/` 下按字母序第一个非 `_` 开头的世界。本 skill 只负责在当前
世界里开局，不负责也无法在会话中切换世界。

启动提示：

```text
开始新游戏。
```

开局后由 GM 初始化游戏状态。Core player/time/scene/attributes 变化使用现有
`update_*` 工具；System module state 变化使用 `commit_turn` operations。
`commit_turn` 只推进状态；玩家可见正文或直接回复仍由 `submit_direction_packet` 单独交接。
