# 贡献指南

## 开发环境

需要 Node.js 22.19 或更高版本，推荐使用仓库 `.nvmrc` 中的版本。

```bash
nvm use
npm ci
npm run typecheck
npm test
```

需要验证真实 Pi 启动链路时，先安装 `@earendil-works/pi-coding-agent`，再运行：

```bash
bash scripts/smoke-demo.sh
```

## 提交变更

- 一个提交只处理一个明确问题。
- 行为变化必须带对应测试，并同步相关设计文档。
- 不要提交 `.env`、认证文件、会话、SQLite 数据库、模型输出或其他运行产物。
- 世界包运行时能力有变化时，同步更新 `docs/design/project-control-plane.md`。
- 提交前执行 `npm run typecheck` 和 `npm test`。

## Pull Request

PR 应说明变更原因、行为影响、验证方式及尚未覆盖的风险。涉及存档格式、世界包 schema、System state 或回退语义时，应明确兼容性影响。
