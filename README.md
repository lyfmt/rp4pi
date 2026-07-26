# rp4pi

[![CI](https://github.com/lyfmt/rp4pi/actions/workflows/ci.yml/badge.svg)](https://github.com/lyfmt/rp4pi/actions/workflows/ci.yml)

基于 [Pi coding agent](https://github.com/earendil-works/pi) 的角色扮演运行时。项目将世界设定、GM 裁定、状态推进、Writer 正文生成、存档回退和 OpenViking 长期记忆组合成一套可替换世界包的工作流。

> 当前版本仍在快速迭代，适合本地体验和二次开发，不保证配置与存档格式向后兼容。

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 世界包 | 用 YAML、Markdown 和可选 TypeScript System module 定义世界、初始状态、提示词、资料、角色、写作规则与 Hook；GM / Writer 的 prompt 可自定义为带 role 的有序消息链 |
| 状态 | SQLite 持久化玩家、场景、时间、自定义属性及独立 System state |
| GM / Writer | GM 负责裁定和状态推进，Writer 负责玩家可见正文，避免写作阶段改写确定性状态 |
| 存档 | 提供 `/save`、`/load`、`/roll`，按成功故事回合保存完整状态快照 |
| 子代理 | 支持世界角色、动态角色和角色专属行为工具 |
| 长期记忆 | 可选接入 OpenViking；当前状态仍以 SQLite 为准 |

运行链路：

```text
玩家输入
-> GM 读取状态、固定资料和长期记忆
-> GM 调用角色子代理并推进 Core / System state
-> GM 提交 story elements
-> Writer 生成并修订正文
-> 正文交付后记录 story snapshot
-> Hook 与 OpenViking 异步处理后续工作
```

## 环境要求

- Node.js 22.19 或更高版本（推荐 Node.js 24）
- npm
- 可在 `PATH` 中调用的 Pi coding agent CLI
- OpenViking 服务（可选，仅长期记忆需要）

安装 Pi CLI：

```bash
npm install --global @earendil-works/pi-coding-agent
```

## 快速开始

```bash
git clone https://github.com/lyfmt/rp4pi.git
cd rp4pi
npm ci
cp .env.example .env
./start.sh
```

首次启动会从 `.pi/agent/settings.example.json` 生成本地的 `.pi/agent/settings.json`。请将其中的 provider、model 和 thinking 配置改为当前 Pi 环境可用的值。本机已有 `~/.pi/agent/auth.json` 时，启动脚本会将其复制到项目的本地配置目录；这些本地认证文件不会被 Git 跟踪。若本机没有现成的 Pi 认证，进入交互界面后先执行 `/login` 登录。

`cp .env.example .env` 生成的配置默认已禁用 OpenViking（`RP_DISABLE_OPENVIKING=1`），全新检出无需本地 OpenViking 服务即可运行。需要长期记忆时，注释掉 `.env` 里的该行并配置 `OPENVIKING_URL`（见下方「配置」）。

启动后输入：

```text
开始新游戏，使用默认 demo 世界。
```

## 配置

OpenViking 连接参数可写入本地 `.env`：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENVIKING_URL` | `http://127.0.0.1:1933` | OpenViking 服务地址 |
| `OPENVIKING_API_KEY` | 空 | API Key |
| `OPENVIKING_ACCOUNT` | 空 | 账户隔离标识 |

其他常用运行参数通过环境变量传入：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `RP_WORLD` | 首个非 `_` 开头的世界目录 | 选择 `worlds/<name>/` |
| `RP_SQLITE_PATH` | `data/rp.sqlite` | SQLite 状态文件位置 |
| `RP_DEMO_MODE` | `1` | 设为 `0` 关闭 demo mode |
| `RP_DISABLE_OPENVIKING` | `1`（`.env.example` 默认设置） | 设为 `1` 禁用长期记忆连接；启用 OpenViking 时注释掉 `.env` 里的该行 |
| `RP_AGENT_ENV_FILE` | `.env` | 指定 OpenViking 环境配置文件 |

密钥只应放在 `.env`、环境变量或 `.pi/agent/` 下的本地文件中，不要写入世界包、源码或 Issue。

## 世界包

默认示例是 `worlds/border-station/`。创建自己的世界：

```bash
cp -r worlds/_template worlds/my-world
npm run validate-world my-world
RP_WORLD=my-world ./start.sh
```

世界包字段和扩展方式见 [world-pack 指南](skills/development-guide/references/world-pack.md)。

### 从 SillyTavern 角色卡迁移

支持从 SillyTavern 角色卡（PNG / WEBP / JPEG / JSON）迁移。在 Pi 会话里让 agent 使用 `migrate-st-card` 技能，它会审计角色卡语义并映射为世界包模块。角色卡提取脚本已收编在 `skills/migrate-st-card/scripts/`（需 Python >= 3.10）。迁移产物是一个 `worlds/<name>/` 世界包。

## 常用命令

```bash
npm run typecheck
npm test
npm run validate-world
bash scripts/smoke-demo.sh
bash scripts/smoke-writer-live.sh
```

`npm run validate-world` 严格校验 `worlds/` 下所有世界包（可传世界名只校验一个），任一世界加载失败即以退出码 1 结束。`smoke-demo.sh` 会执行类型检查、全量测试、扩展启动检查，并在 OpenViking 可达时验证真实的 append / commit 流程。`smoke-writer-live.sh` 会调用真实模型；可通过 `RP_WRITER_LIVE_SMOKE=0` 跳过。

运行中的 Slash Commands：

| 命令 | 作用 |
| --- | --- |
| `/status` | 查看当前玩家、地点、时间和场景 |
| `/save` | 保存并返回 save id |
| `/load` | 切换当前 Pi session 绑定的存档 |
| `/roll` | 回退到上一成功 story snapshot 并重跑当前输入 |

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `extensions/` | Pi 扩展入口 |
| `src/` | 运行时、状态、工具、命令、System 与 OpenViking 集成 |
| `worlds/` | 世界包模板和可运行示例 |
| `agents/`、`.pi/agents/` | GM 与 Writer 提示词 |
| `skills/` | 启动、开发、角色生成和迁移技能 |
| `test/` | 单元、契约和端到端测试 |
| `docs/design/project-control-plane.md` | 当前实现、约束和里程碑的权威说明 |

更完整的演示说明见 [docs/demo.md](docs/demo.md)，当前能力边界见 [项目控制面](./docs/design/project-control-plane.md)。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
