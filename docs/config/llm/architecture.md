# LLM 配置模块架构

## 架构概览

模型库保存用户意图和自动证据，后端统一投影有效数值，运行层只消费完整配置。

```text
Settings / connect
  → 校验并原子保存模型库
  → 返回保存结果
  → 后台 context metadata / reasoning 发现
  → 按 generation 与 routeKey 写回证据、通知刷新

模型库读取 → 旧格式迁移与兼容清理 → 过滤异路由证据
  → 覆盖 / 检测 / 产品默认解析 → LLMConfig → RunModel → 主、子代理
```

Save 不等待网络，网络不占配置发布锁；写入失败不启动有效探测，探测失败不撤销已保存意图。context 与 reasoning 独立记录阶段状态，开始、阶段变化和所有终态都通知消费者重新读取。

## 设计模式与理由

**存储与运行投影分离**

版本 2 模型库中的 context/output 是可选用户覆盖。纯解析函数使用“覆盖 > 同路由 context 证据 > 300000”和“输出覆盖 > 32768”，运行 `maxTokens` 保持必填。默认值集中于 `modelProfiles.ts`，不通过 Settings 输入框或 writer 回写。

**结构校验与单模型可用性分离**

类型、格式、正整数等错误拒绝保存。context 无法容纳输出及安全余量时仍保存证据与设置视图，返回 `tokenBudgetIssue`；在新 run 准备阶段拒绝该模型，其他模型继续使用。已运行的模型快照不追溯修改。

**复用发现调度器**

新建完整连接、改连接、能力 unknown 时的实际修改 Save、Detect again、设为默认触发发现。已有可信能力的普通保存复用缓存；手动 Detect again 强制刷新自动能力。已有任务时，单纯 label、数值或 effort 编辑不重启任务。明确重探替换旧任务；generation 和 routeKey 拒绝旧回包，包括 A→B→A。

启动、Settings 列表读取、配置热重载和准备新 run 都不主动发起付费探测。能力未知时新 run 不等待，使用 service-default，不发送 effort；保留用户偏好。相同路由旧证据在重新探测失败后保留，状态 identified，失败原因只在内存中展示。

**协议能力与偏好分离**

Responses 可发送经有效能力确认的 max。Anthropic adaptive 在统一能力出口过滤 minimal，只有 minimal 的证据变为 unknown；显式合法 effortMap 保留。旧模型默认偏好若实际会发送 minimal，读取时清理并生成内存通知，下一次写入持久化。新显式无效选择拒绝；会话/单次偏好在已知能力时校验，未知时遵循 service-default。

## 模块结构与文件组织

| 位置 | 职责 |
| --- | --- |
| `config/llm/loaders.ts` | 原始 JSON、env 读取 |
| `config/llm/model-document.ts` | 版本迁移、存储校验、路由过滤、有效值与读取视图投影、清理通知 |
| `config/llm/writer.ts` / `config-coordination.ts` | 变更校验、凭证事务保护、原子发布、检测写回与并发协调 |
| `config/llm/apply-active-model-config.ts` | connect 适配与共用发现调度器 |
| `config/llm/context-window-probe.ts` / `reasoning-active-probe.ts` | metadata 发现、主动能力探测 |
| `config/llm/manager.ts` | 默认模型旧接口的缓存与重载；指定条目使用独立加载 |
| `services/llm-model/modelProfiles.ts` / `reasoning-view.ts` | 默认常量、预算解析、能力状态视图 |
| `adapters/ui-inprocess/model-client-pool.ts` / `ui-runtime/run-model.ts` | 会话模型解析、客户端复用、运行快照与预算准入 |
| `ohbaby-llm` | 运行配置校验、有效能力解析及各协议序列化 |
| `ohbaby-sdk` / `ohbaby-server` / Web / TUI | 同步覆盖、检测、有效值契约与可见状态 |

## 架构约束与权衡

- routeKey 由 provider/model/协议/规范化 base URL 构成，context 与自动 reasoning 共用；key 改动保留 context、重探 reasoning，不保存凭证指纹。
- 配置发布锁是进程内协调；原子替换与回滚保护文件提交，不提供跨进程事务。
- 自动状态和失败原因不持久化；重启不会恢复永久 detecting，也不会启动探测恢复队列。无 TTL、无周期刷新。
- 主动探测只有 400/422 表示参数不支持，其余失败为 unknown；档位并发验证、总期限 60 秒，每次请求携带空工具定义，不执行工具。
- 300000 兜底与显式 32768 输出不保证所有第三方兼容；保留可修正问题，不静默扩容或降低输出，也不随 effort 改动额度。
