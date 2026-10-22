# 无工作区会话与设置后端

本议题于 2026-10-20 开启。2026-10-22 将设置从 improve-1 独立为 improve-2，并根据已确认的讨论整理后端规划。两轮的范围与状态分别记录，不能把规划完成当成实施完成。

## 轮次与边界

| 轮次 | 范围 | 当前状态 |
|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 默认工作区、会话归属与目录切换、全局列表与搜索，以及对应 Web 接入 | 工作区后端主体已落地；SDK 全局客户端方法和 Web 接入 G1 等尚未完成，详见 [05](improve-1/05-implementation-acceptance.md) |
| [improve-2](improve-2/00-discussion.md) | 设置后端：独立模型配置与全局默认模型、全局 MCP 管理、搜索配置、Skills/Agents 只读、关于、变更通知及生效 | 已整理确认后的规划，尚未实施；本轮不做前端 |

设置的现行方案以 improve-2 为准，取代 improve-1 的原设置批次。improve-1 的工作区 Web 接入仍留在原轮；设置页面入口和布局以后讨论。improve-2 不依赖 G1 完成，不提前创建其实施验收文档。

## improve-2 已确认的边界

- 每个模型有独立的完整连接配置和 key；新增只保存，明确选择全局默认模型后下一轮生效。
- 每个模型条目自带完整连接配置，直接存在 `models[]` 中，不另建 provider 连接表；新设置接口不查重，同名模型可因 key 不同分别保存，以可选备注区分。
- 模型列表顺序稳定；删除当前模型或服务商后按原列表顺延循环。删除即移除整个条目，只保留 `.env` 中的 key；没有可选模型则没有默认模型。
- 推理能力按条目记录：保留内置规则但去掉 provider 名称条件；候选模型保存后只读元数据，主动探测只在选为当前模型或手动 probe 时进行；未知时使用默认 Reasoning 行为，不猜档位、不反复提示。
- 全局配置在 daemon 全局层读写，目录运行状态在实例层读取；只写全局文件，项目配置只读。
- MCP 下一轮应用，需要时只重连当前项目，不自动重连所有空闲项目。Skill 更新、增删复用现有机制补齐自动刷新。
- 本轮只交付后端及 SDK 契约；保留旧 TUI、HTTP 与 JSON-RPC 入口，不新增通用配置存储或文件监听系统。

## 文档地图

| 内容 | improve-1 | improve-2 |
|---|---|---|
| 讨论与决策 | [00](improve-1/00-discussion.md) | [00](improve-2/00-discussion.md) |
| 现状与缺口 | [01](improve-1/01-problem-analysis-and-current-state.md) | [01](improve-2/01-problem-analysis-and-current-state.md) |
| 方案与改动面 | [02](improve-1/02-optimization-plan-and-change-scope.md) | [02](improve-2/02-optimization-plan-and-change-scope.md) |
| 参考项目 | [03](improve-1/03-reference-projects.md) | [03](improve-2/03-reference-projects.md) |
| 测试与验收标准 | [04](improve-1/04-test-and-acceptance.md) | [04](improve-2/04-test-and-acceptance.md) |
| 实施验收 | [05](improve-1/05-implementation-acceptance.md)，尚未整轮闭环 | 实施后再创建，目前不存在 |

每轮的 02 是实施依据，04 是验收依据。improve-2 代码现状基线为 `231eb8e1`；本次只整理规划文档，不写业务代码。

## 相关文档

- [Web 会话侧栏整理（2026-09-30）](../2026-09-30-web-session-sidebar/README.md)：替换单目录分组，保留置顶等已落地能力。
- [全局单 Daemon](../2026-07-11-global-single-daemon/README.md)：沿用 `InstanceStore` 与请求级目录头。
- [多项目运行时](../../ohbaby-server/hono-app/04-multi-project-runtime.md)：设置实施后同步。
- [Web 架构](../../ohbaby-web/architecture.md)、[UI 组件约定](../../ohbaby-web/ui/components.md)。
- `daemon-workspace-scope` 已归档，不作为依据。
