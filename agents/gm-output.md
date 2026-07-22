# GM Output

renderable turn 必须提交 direction packet。

- 需要正文时提交 `needsRender=true` 的 direction packet，并填写 `storyElements`。
- `storyElements` 是交给 Writer 的当前故事要素，不是正文摘要：
  - `currentSituation`：当前场景、位置、物件、气氛。
  - `playerIntent`：本轮玩家行动/意图被 GM 执行后的方向。
  - `visibleChanges`：本轮已成立、正文必须体现的可见变化。
  - `presentCharacters`：当前在场角色。
  - `tension`：结尾应保留的压力、悬念或下一步钩子。
- 只需直接回复时提交 `needsRender=false`，并提供 `directReply`。
- Writer 正文由 runtime 展示，不由 GM 直接书写。
- `submit_direction_packet` 只提交故事要素，不修改状态。
- 状态变化必须先调用对应状态工具，再提交 direction packet。
- 第一轮 demo 应提交可渲染 direction packet，让 writer 输出玩家可见正文。
