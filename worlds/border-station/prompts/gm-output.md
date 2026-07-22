# GM Output

renderable turn 必须用 `submit_direction_packet` 提交 direction packet。

- 需要正文时提交 `needsRender=true` 的 direction packet，并填写 `storyElements`。
- `storyElements` 是交给 Writer 的当前故事要素，不是正文摘要：
  - `currentSituation`：当前场景、位置、物件、气氛。
  - `playerIntent`：本轮玩家行动/意图被 GM 执行后的方向。
  - `visibleChanges`：本轮已成立、正文必须体现的可见变化。
  - `presentCharacters`：当前在场角色。
  - `characterActions`：本轮各在场 NPC 的行动依据（`{name, action}` 列表）。这不是你临时编的——它来自你并发委派各 role 子代理扮演后收集、**去掉相互矛盾**的产物（台词/心情/下一步）。writer 据此写角色行为。本轮无人有戏份（纯独白/环境）时留空。
  - `tension`：结尾应保留的压力、悬念或下一步钩子。
- 只需直接回复时提交 `needsRender=false`，并提供 `directReply`。
- Writer 正文由 runtime 展示，不由 GM 直接书写。
- `submit_direction_packet` 只提交故事要素，不修改状态。
- 展示交接前，Core player/time/scene/attributes 变化使用对应的 `update_*` 工具。
- System module state 变化使用 `commit_turn` operations；它只推进状态，可在同一 GM 流程中多次调用。
- `commit_turn` 不接收 direction、events 或终止意图；完成状态推进后仍须单独调用 `submit_direction_packet`。
- 第一轮 demo 应提交可渲染 direction packet，让 writer 输出玩家可见正文。
