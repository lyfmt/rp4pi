# Demo

本 demo 使用自带的 `border-station` 世界包：玩家在边境驿站醒来，场景中有一个受伤信使和一封未送达的密信。它既验证 scaffold 的完整链路，也是世界包系统的「真实范例」。

世界包是可替换单位，见 [world-pack 指南](../skills/development-guide/references/world-pack.md)。
选择哪个世界：`RP_WORLD=<name> ./start.sh`；不指定则用 `worlds/` 下按字母序第一个（非 `_` 开头）。

## 配置 SQLite

默认数据库路径来自运行时配置。需要指定路径时设置：

```bash
export RP_SQLITE_PATH="./sessions/rp-state.sqlite"
```

## 配置 OpenViking

启用长期记忆需要配置：

```bash
export OPENVIKING_URL="http://127.0.0.1:1933"
export OPENVIKING_API_KEY="..."
export OPENVIKING_ACCOUNT="..."
```

OpenViking memory schema 位于世界包内，如 `worlds/border-station/memory`。
`memory_policy` 由世界包的 `memory.policy` 声明，不再硬编码。建议配置 OV 服务端：

```json
{
  "memory": {
    "custom_templates_dir": "/absolute/path/to/project/worlds/border-station/memory"
  }
}
```

如果当前 OpenViking 服务未加载项目 schema，运行时会自动降级到内置
`entities` / `events` 记忆类型，保证后台仍能沉淀角色和事件类记忆。

OV commit 使用异步模式，返回 `task_id` 后后台继续提取记忆。因此记忆检索是最终一致的，下一轮不保证立刻能查到刚提交的内容。

## 启动 Demo

```bash
./start.sh
```

在 Pi 中使用 start-game skill，或直接输入：

```text
开始新游戏。
```

第一轮应触发：

- `initialize_new_game`
- `get_status` / `lookup` / `read_lore`（按需）
- `update_*`（Core player/time/scene/attributes 变化时按字段调用）
- `commit_turn`（有 System module state 变化时提交 operations，可调用多次）
- `submit_direction_packet`（提交 direction packet 或直接回复）
- writer prose custom message
- SQLite story snapshot
- OpenViking append + commit（如果已配置）

状态推进和展示交接彼此独立。Core 变化走 `update_*`，System state 变化走
`commit_turn`；两者完成后再单独调用 `submit_direction_packet`，后者不修改状态；
`needsRender=true` 的正文成功交付后才记录 story snapshot。

## Slash Commands

可用命令：

- `/status`：查看玩家、状态、地点、时间和场景。
- `/save`：刷新当前 save 的更新时间，并只输出 save id。
- `/load`：选择 save，切换当前 Pi session 的 save binding。
- `/roll`：回到当前 save 内上一成功 story snapshot，并用最新玩家输入重跑 turn。

## Smoke

运行：

```bash
bash scripts/smoke-demo.sh
bash scripts/smoke-writer-live.sh
```

脚本会执行 typecheck、全量测试、`start.sh` 可执行检查，还会按当前
OpenViking 配置执行一次真实 append + commit，并轮询后台 task，确认确实产生记忆写入。

- `bash scripts/smoke-demo.sh`：无 OpenViking 或服务不可达时输出 `SKIP live OpenViking smoke...` 并返回 0；可达时继续做 health、append+commit、task poll、memory extraction 的严格 live 校验。
- `bash scripts/smoke-writer-live.sh`：使用当前 `start.sh` 和 `.pi/agent/settings.json` 跑一次隔离真实回合，GM 与 writer 使用同一套当前主模型配置。设置 `RP_WRITER_LIVE_SMOKE=0` 时输出 `SKIP live writer smoke...` 并返回 0。
- `bash scripts/smoke-two-turn-live.sh`：同一会话连发两条输入的双回合真实冒烟，额外验证第二回合 writer history 回放、快照序号递增与逐回合 clock-drift；也是连发输入排水（story commit 在下一条输入前落盘）的回归测试。同样受 `RP_WRITER_LIVE_SMOKE=0` 跳过控制。
