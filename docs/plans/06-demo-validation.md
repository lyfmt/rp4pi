# 阶段 6：Demo 与全链路验证计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 固定一个最小 demo 世界，跑通玩家输入 -> GM state tools -> direction packet -> writer prose -> custom message -> SQLite snapshot -> OV async commit -> slash commands 的完整流程。

**架构：** Demo 世界只验证 scaffold 能力，不做复杂世界模板。用 smoke tests 和一次真实 TUI/CLI 启动验证端到端。

**技术栈：** TypeScript、pi TUI、OpenViking server、node:test、shell smoke script。

---

## 文件结构

创建：

```text
data/demo-world.md
scripts/smoke-demo.sh
test/e2e/demo-flow.test.ts
docs/demo.md
```

修改：

```text
agents/gm-core.md
agents/gm-tools.md
agents/gm-output.md
skills/start-game/SKILL.md
README.md
```

## Demo 世界

MVP 固定世界：

```text
玩家在一座边境驿站醒来。
场景有一个受伤信使和一封未送达的密信。
第一轮应能更新地点、玩家状态、时间、场景，并让 writer 输出正文。
```

目标是触发：

- `initialize_new_game`
- `update_location`
- `update_player_status`
- `update_time`
- `update_scene`
- `submit_direction_packet`
- writer prose
- OV turn memory hook

## 任务 1：Demo world 与 prompt 收束

- [ ] **步骤 1：创建 `data/demo-world.md`**

内容只包含最小世界事实，不做模板选择。

- [ ] **步骤 2：更新 GM prompt**

加入：

```text
开局必须初始化游戏。
状态变化必须调用工具。
需要正文时提交 direction packet。
提到旧人物/事件时可 search_memory/read_memory。
```

- [ ] **步骤 3：更新 start-game skill**

提供一个启动提示：

```text
开始新游戏，使用默认 demo 世界。
```

## 任务 2：E2E mock flow

- [ ] **步骤 1：写失败测试**

`test/e2e/demo-flow.test.ts` 使用 fake GM/writer/OV client，验证：

```text
initialize state
mutate state
submit packet
writer returns prose
custom message recorded
snapshot recorded
OV append+commit called
```

- [ ] **步骤 2：补齐 runtime adapter**

让 e2e test 可以在不启动真实 pi 的情况下跑核心流程。

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/e2e/demo-flow.test.ts
npm run typecheck
```

预期：PASS。

## 任务 3：Smoke script

- [ ] **步骤 1：创建 `scripts/smoke-demo.sh`**

检查：

```text
npm run typecheck
npm test
OV config 是否存在
start.sh 是否可执行
```

如果 OV 未配置，脚本应明确输出：

```text
SKIP OpenViking live smoke: OPENVIKING_URL is not set
```

不能伪装成 live OV 通过。

- [ ] **步骤 2：运行 smoke**

```bash
bash scripts/smoke-demo.sh
```

预期：typecheck/test 通过；OV live smoke 视环境配置 PASS 或 SKIP。

## 任务 4：真实 OV 验证

- [ ] **步骤 1：确认 OV server**

运行：

```bash
curl -sS "$OPENVIKING_URL/health"
```

预期：返回健康状态。若网络或服务不可用，记录为未执行，不声称 live OV 通过。

- [ ] **步骤 2：运行一次真实 turn commit**

使用 demo player input 和 fake writer prose 调用 OV hook：

```text
append user
append assistant
commit wait=false keep_recent_count=0
```

预期：返回 `status=accepted`，可有 `task_id`，不落 SQLite。

- [ ] **步骤 3：验证 search/read**

等待少量时间后，调用 `search_memory`。如果 Phase 2 未完成，可以记录「最终一致，暂未召回」，不作为 state 失败。

## 任务 5：文档收尾

- [ ] **步骤 1：创建 `docs/demo.md`**

说明：

- 如何配置 SQLite 路径。
- 如何配置 OpenViking。
- 如何启动 demo。
- 如何使用 slash commands。
- OV 是最终一致，不保证下一轮立即可查。

- [ ] **步骤 2：创建或更新 README**

只放最小启动步骤和文档链接。

## 阶段验收

- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 通过。
- [ ] `bash scripts/smoke-demo.sh` 运行完成。
- [ ] 若 OV 环境可用，真实 append+commit 返回 accepted。
- [ ] `/status`、`/save`、`/load`、`/roll` 在 demo 中有可验证路径。
- [ ] writer prose 可见，但不进入 GM context。
- [ ] 成功 story turn 写 SQLite snapshot。
- [ ] OV 只接收玩家输入 + writer 正文。
