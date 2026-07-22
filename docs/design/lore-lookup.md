# Lore Lookup Design

固定资料 lookup 用来把世界权威设定从 prompt 和长期记忆里拆出来。

## 分工

| 数据 | 含义 | 存储 | 工具 |
| --- | --- | --- | --- |
| 固定资料 | 不随存档变化的人物、地点、背景、规则、等级、丹药等 | 世界包 YAML，启动导入 SQLite lore index | `lookup` / `read_lore` |
| 当前状态 | 当前存档的确定性事实：玩家、地点、时间、场景、属性、facts、relationships | SQLite `latest_states` | `get_status` / 现有 `update_*` 工具 |
| 长期记忆 | 当前存档已经经历过的旧事件、旧承诺、旧人物变化 | OpenViking | `search_memory` / `read_memory` |

固定资料不写进 OpenViking；长期经历不写进 lore；当前状态不靠 prompt 记忆维持。

## 世界包格式

`world.yaml` 声明 lore 模块：

```yaml
lore: ./lore.yaml
```

`lore.yaml` 声明源文件：

```yaml
version: 1
sources:
  - path: ./lore/characters.yaml
    default_kind: character
  - path: ./lore/locations.yaml
    default_kind: location
  - path: ./lore/rules.yaml
    default_kind: rule
```

源文件是可 diff 的 YAML：

```yaml
- id: character.han-yue
  name: 韩越
  aliases: [受伤信使]
  summary: 携带未送达密信抵达北门驿站的受伤信使。
  body: 他失血未止但仍保持清醒。
  tags: [信使, 密信]
  visibility: public
  fields:
    role: 信使
  relations:
    - { type: carries, target: background.undelivered-letter }
```

## 工具选择

| 问题 | 用什么 |
| --- | --- |
| “韩越是谁？”且答案来自世界设定 | `lookup`，必要时 `read_lore` |
| “玩家现在在哪？” | `get_status` |
| “玩家之前答应过谁？” | `search_memory`，必要时 `read_memory` |
| “本轮韩越开始信任玩家” | 当前没有通用 relationships 写入工具；等待新的扩展能力设计 |

`lookup` 返回短结果和摘要，不返回全文 body；`read_lore` 按 id 读取完整条目。
现有 `update_*` 只覆盖固定核心字段和世界声明的 attributes；不要用 prompt
伪装 facts/relationships 已有可靠写入能力。

## Visibility

`visibility` 是资料边界元数据：

- `public`：可作为普通世界设定使用。
- `gm`：GM 可见，通常不直接暴露给玩家。
- `secret`：保留给隐藏设定；角色是否能知道由 prompt 与子代理工具白名单约束。

第一版不做复杂权限系统。role 子代理默认不给 `lookup/read_lore`，研究型或导演型子代理需要在 `subagents.yaml` 里显式白名单。

## 为什么 SQLite 只是运行索引

世界作者编辑 YAML，而不是编辑 SQLite：

- YAML 可 review、可 diff、可随世界包一起复制。
- SQLite 提供启动后的快速本地检索和跨工具共享。
- 每次启动从 active world 重新导入，避免运行索引成为第二来源。
