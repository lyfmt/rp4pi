# Render & Delivery Development Reference

## Core Rule

正文渲染与交付（writer、修订、回合活动挂件、story commit）全部是**展示侧**：状态权威永远在 GM 侧工具。story snapshot、`turn_committed` 钩子与 OV 记忆沉淀只发生在正文**成功交付之后**。

## 两遍链路（two-pass）

```text
GM（Pass A）… submit_direction_packet 终止 GM loop
  → two-pass-render 扩展 agent_end（extensions/two-pass-render/index.ts）
  → writer 渲染（src/runtime/writer-client.ts）
  → 修订管道：style enhance → 惯性/陈词批评员 → 有界重写（src/runtime/writer-revision.ts）
  → idle 交付 custom message（src/runtime/idle-delivery.ts）
  → story snapshot 落盘（turn_snapshots）
  → turn-events 总线广播 turn_committed（src/runtime/turn-events.ts）
  → core 扩展跑 turn_committed 钩子；openviking-memory 扩展 append+commit
```

- writer 是**主进程内**的只读工具循环 agent（不是 pi-subagents 子进程），persona 在 `.pi/agents/writer.md`。工具面由 `buildWriterTools`（src/runtime/writer-tools.ts）注入：`get_status`、`lookup`/`read_lore`、`read_writing_guide`、`search_memory`/`read_memory`（OV 可用时），全部只读，与 GM 共享同一 bootstrap db/stateStore/ovClient。
- `submit_direction_packet` 是唯一展示交接，不写状态；`needsRender=true` 的正文成功交付后才记 snapshot。
- `turn_snapshots` 存 envelope（核心状态在 `core.payload`）；`latest_states` 才是扁平核心状态。写断言/排错时别混（冒烟脚本里有现成取法）。

## 回合活动挂件（turn activity widget）

- `src/runtime/turn-activity.ts`：纯状态机 + 渲染，可无 pi 单测；`src/runtime/turn-activity-widget.ts`：pi `ui.setWidget` 接线，编辑器上方多行动画面板。
- 流式预览：writer-client 的 `CompleteOptions.onText` → `model_delta` 进度事件；draft / styleEnhancer / rewrite 三个「输出即正文」的阶段展示清洗后的正文尾部（`visibleStreamText` 剥 thinking/content 标签）。
- 记忆沉淀（openviking 阶段）有专属脉冲图标 ◇◈◆，跨 pipeline_done 保活；终局 ✓ 带提取条数，✗ 只在确证失败时，超时是「状态未知」。
- 挂件所有权按 ui 对象用 WeakMap 记录，防上一回合迟到的清理拆掉下一回合挂件；sink 进终态后忽略一切事件；单行 label sink 完全忽略 openviking 事件（分钟级迟到 stage_end 会写坏下一回合 loader）。

## 记忆沉淀可见性（extraction watch）

OV `POST /commit` 只是**入队**并返回 task_id，真实提取是分钟级服务端 LLM 任务。`src/ov/extraction-watch.ts` 的分离式 watcher 轮询 `GET /api/v1/tasks/{id}`（需要 save-scoped `X-OpenViking-User` header）直到 completed/failed：

- 超时或任务 API 连续 3 次不可达 → `memory_unknown`（「状态未知」），绝不假 ✗。
- watcher 与 story-commit 排水链**解耦**：不阻塞退出/连发输入；新回合与 session_shutdown 取消在途 watcher，取消后不发事件。
- env 旋钮：`OPENVIKING_EXTRACT_WATCH_TIMEOUT_MS`（默认 600s）、`OPENVIKING_EXTRACT_POLL_INTERVAL_MS`（默认 3s），见 src/ov/config.ts。
- 手动查任务/查记忆：`node scripts/ov-inspect.ts --save <saveId> --task <taskId> | --query <text>`。

## story commit 排水（in-flight drain）

story commit（交付→快照→钩子→记忆）在 agent_end 后**后台**运行，pi 不 await 它。`src/runtime/story-commit-tracker.ts` 用 globalThis Symbol 登记在途 commit，所有扩展共享同一集合。排水点：

- two-pass-render 的 `input` 事件（非 streaming 时）：连发输入前排干上一回合，正文先于新用户消息落 transcript，writer history 与 GM 上下文保持有序。
- 三个扩展各自的 `session_shutdown`：core 必须**先排水再退订** turn_committed 监听（shutdown 处理器按激活序执行，core 最先）。

历史 bug（勿回归）：`pi -p` 单发模式 dispose 掐断后台链丢快照/钩子/记忆；连发输入 idle 轮询竞态丢上一回合。

## pi 契约要点（排错先想这些）

- agent_end 处理器执行期间 `isStreaming` 仍为 true，`finishRun` 在监听器 settle 后才翻 false → 处理器内等 idle 会死等。
- streaming 中 `sendMessage` 走 steer 队列并让 agent loop 续跑（「GM 继续工作」类怪象的根源）。
- `session_shutdown` 处理器在 ctx 失效前被 await——唯一安全的关闭排水点；`deliverAs: "nextTurn"` 只在下一 prompt 到来时落盘，会话结束即丢。

## 验证

```bash
npm test                              # 单测/合约测(含排水与挂件状态机)
bash scripts/smoke-writer-live.sh     # 单回合真实链路:writer+修订+快照+OV binding
bash scripts/smoke-two-turn-live.sh   # 双回合:writer history 回放/快照递增/逐回合钩子/排水回归
```

真实 TUI 观察用 tmux 探针；挂件的 1.5s 驻留帧要 `tmux pipe-pane` 连续录流才逮得住。
