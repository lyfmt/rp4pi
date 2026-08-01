# `/rpconfig` 模型配置入口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 在当前会话中逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 `/rpconfig` 两段式选择入口，让用户为 Writer、文风增强/惯性审稿/八股审稿模型及当前世界的静态、动态 RP 子代理选择 Pi 中已认证可用的模型。

**架构：** 配置读写集中在独立模块，按目标更新 `.pi/agent/settings.json` 并保留无关字段与现有 `thinking`；命令注册层只负责编排“选择配置目标 -> 选择可用模型 -> 写入 -> 刷新子代理投影”。TUI 使用现有可搜索分页选择组件，其他 UI 模式回退到 `ui.select`；Writer 每次渲染本就重读设置，子代理则在写入后重新物化，因此无需重启。

**技术栈：** TypeScript、Pi Extension API、Node.js `node:test`、JSON 原子写入。

---

## 文件结构

- 创建：`src/commands/rpconfig.ts`：模型目标解析、配置原子写入和 `/rpconfig` 交互注册。
- 修改：`src/commands/save-picker-component.ts`：抽出可复用的搜索/分页选择器，同时保留存档选择兼容包装。
- 修改：`src/commands/registry.ts`：注册 `/rpconfig` 并传入项目配置上下文。
- 修改：`extensions/core.ts`：提供当前世界静态/动态子代理清单及配置后重物化回调。
- 修改：`src/types/pi.ts`：补齐命令实际使用的 ModelRegistry 能力与模型结构。
- 创建：`test/commands/rpconfig.test.ts`：覆盖目标发现、配置持久化、交互顺序、取消及即时刷新。
- 修改：`test/commands/save-picker-component.test.ts`：覆盖通用选择器标题和模型式条目。
- 修改：`test/commands/extension-commands.test.ts`：更新命令注册契约。
- 修改：`README.md`：记录 `/rpconfig` 的范围和操作方式。

### 任务 1：锁定配置读写契约

- [x] **步骤 1：编写失败的配置测试**

在 `test/commands/rpconfig.test.ts` 构造临时 `.pi/agent/settings.json`，断言目标列表包含 Writer、三个修订阶段和传入子代理，并正确展示继承后的当前模型。

- [x] **步骤 2：编写持久化失败测试**

断言更新 Writer、修订阶段和子代理时只改对应 `provider`/`model`，保留 `thinking`、`openViking` 及其他未知字段；子代理用完整 `provider/model-id` 写法兼容包含 `/` 的模型 ID。

- [x] **步骤 3：运行测试确认失败**

```bash
node --test test/commands/rpconfig.test.ts
```

预期：FAIL，原因是 `src/commands/rpconfig.ts` 尚不存在。

- [x] **步骤 4：实现最小配置模块**

实现类型化目标：

```ts
type RpModelTarget =
  | { kind: "writer"; id: "writer"; current?: RpModelRef; thinking?: string }
  | { kind: "writerAgent"; id: string; stage: WriterAgentStage; current?: RpModelRef; thinking?: string }
  | { kind: "subagent"; id: string; name: string; current?: RpModelRef; thinking?: string };
```

读取时应用现有回退链；写入时读取完整 JSON、局部更新、写临时文件后 `renameSync` 覆盖。

- [x] **步骤 5：运行配置测试确认通过**

```bash
node --test test/commands/rpconfig.test.ts
```

预期：配置相关用例 PASS。

### 任务 2：实现两段式可搜索交互

- [x] **步骤 1：为通用选择器编写失败测试**

扩展 `test/commands/save-picker-component.test.ts`，断言自定义标题、空结果文案、过滤和确认返回稳定 id。

- [x] **步骤 2：运行选择器测试确认失败**

```bash
node --test test/commands/save-picker-component.test.ts
```

预期：FAIL，原因是尚无通用选择器导出。

- [x] **步骤 3：抽出通用搜索选择器**

在 `src/commands/save-picker-component.ts` 增加 `createSearchablePickerComponent`，让 `createSavePickerComponent` 成为兼容包装；保持每页 10 条、键盘移动、翻页、输入过滤、Enter 确认和 Esc 取消。

- [x] **步骤 4：编写 `/rpconfig` 命令交互测试**

用假的 `ui.select` / `ui.custom` 与 `modelRegistry.getAvailable()` 断言调用顺序是目标选择后模型选择；取消任一步均不写设置；成功后通知并触发子代理刷新一次。

- [x] **步骤 5：实现命令注册和模型选择**

模型只取 `modelRegistry.getAvailable()`，条目采用 Pi 原生风格的 `model-id [provider]`，当前模型优先并标记；TUI 使用可搜索组件，非 TUI 使用 `ui.select`。

- [x] **步骤 6：运行命令测试确认通过**

```bash
node --test test/commands/rpconfig.test.ts test/commands/save-picker-component.test.ts
```

预期：PASS。

### 任务 3：接入运行时并验证即时生效

- [x] **步骤 1：更新注册契约测试**

将 `test/commands/extension-commands.test.ts` 的命令集合加入 `rpconfig`，并增加一次完整命令调用，确认 Pi context 的模型注册表和 UI 能驱动配置更新。

- [x] **步骤 2：接入 Core 上下文**

`extensions/core.ts` 将 `world.subagents` 与当前绑定存档的 `listDynamicRoles()` 合并提供给命令；子代理设置落盘后调用 `materializeWorldSubagents()` 和 `materializeDynamicRoles()`，保证后续委派读取新模型。

- [x] **步骤 3：补齐本地 Pi 结构类型**

为 `ExtensionContextLike.modelRegistry` 增加 `refresh`、`getError`、`getAvailable`，模型至少暴露 `provider`、`id`、可选 `name`。

- [x] **步骤 4：更新 README**

在配置和 Slash Commands 表中说明 `/rpconfig` 管理的模型范围、两段式选择，以及 `/model` 仍负责当前 GM 主模型。

- [x] **步骤 5：运行聚焦测试**

```bash
node --test test/commands/rpconfig.test.ts test/commands/save-picker-component.test.ts test/commands/extension-commands.test.ts test/world/materialize-subagents.test.ts test/world/materialize-dynamic-roles.test.ts test/runtime/writer-client.test.ts
```

预期：PASS。

- [x] **步骤 6：运行完整校验**

```bash
npm run typecheck
npm test
```

预期：全部 PASS。
