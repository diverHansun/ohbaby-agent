# 讨论记录与已确认要点

## 1. 背景与动机

用户在两种正式形态中观察到原始 JSON：

- TUI 使用 in-process backend 时，执行 slash command 后，Ink 界面中穿插 `{"record": ...}`；
- `ohbaby serve` 启动 Web backend 后，daemon 所在终端持续输出同类 JSON。

这些内容不是模型回复，也不是 TUI 业务消息，而是 SDK command gateway 生成的内部 `UiCommandRecord`。它们被默认 structured recorder 和 hard-coded diagnostic reporter 直接写入了进程 stream，因此绕过 Ink 渲染树，也绕过 Web UI。

用户判断正确：这不是“显示得不够好”，而是默认输出边界错误，会破坏用户输入节奏，属于 Bug。

## 2. 已确认：目标与范围

| 议题 | 已确认结论 |
| --- | --- |
| 默认用户体验 | in-process TUI 与 `ohbaby serve` 默认都不得输出任何 `ui.command.*` JSON |
| 记录能力 | 保留 SDK record/gateway 合同和显式 recorder 注入能力 |
| 默认 recorder | Agent 与 Server 在 `undefined` 或 `false` 时都使用各自本地 no-op，且不再依赖 `NODE_ENV` |
| structured recorder | sink 必须显式提供；缺失在构造期 fail-fast；不再默认 stdout |
| diagnostic | 默认静默且 fail-open；composition root 不绑定 terminal reporter |
| lifecycle | 默认 composition 没有 recorder drain；显式注入者负责自己 recorder 的 flush/dispose |
| 持久回归保护 | 精确 lint 禁止低层 recorder 使用 process streams；真实子进程测试验证 production 默认静默 |
| 产品形态 | TUI 是同一 Node.js 进程内前后端；Web 使用 `ohbaby serve`；不存在需要设计的 `ohbaby run` 形态 |

## 3. 已确认：边界（不做的事）

| 候选做法 | 结论与原因 |
| --- | --- |
| stdout 改 stderr | 不做；两者都会越过 UI owner 并破坏终端 |
| 在 TUI 过滤 JSON | 不做；Server 仍泄漏，根因仍存在，且渲染层不应识别内部序列化格式 |
| patch 全局 stdout/stderr | 不做；会掩盖其他合法输出并增加不可预测副作用 |
| 接入 `OHBABY_DEBUG` | 本批不做；已有变量只证明仓库知道“默认静默”的范式，不构成给 command record 新增产品出口的需求 |
| 新增 debug/quiet/log 配置 | 不做；不能把默认行为 Bug 变成用户配置负担 |
| SDK 共享 no-op | 不做；为了消除两段数行的私有空实现而扩大公共 API，收益不足 |
| Agent/Server 新增 diagnostic option | 不做；没有真实调用方，SDK seam 已足够，等明确需求出现再设计 |
| 宽泛禁止 host/app 中的 process stream | 不做；会误伤合法、不同语义的产品输出。lint 只保护根因模块 |
| 人工 source review 作为唯一门 | 不做；改用 lint + 行为测试 + 真实子进程测试 |

## 4. 与关联议题的关系

### 4.1 保留 2026-08-13 已验证的合同

本批不推翻既有 command record 设计：

- gateway 仍是命令 observation 的唯一所有者；
- started/completed 仍共享 operationId；
- correlation、details、redaction 和 trusted queue owner 不变；
- recorder 失败仍不影响业务命令结果；
- 显式注入的 recorder 仍可收集结构化记录。

改变的只有默认 I/O policy 与 recorder 创建责任。

### 4.2 Supersede 默认生产 sink 策略

旧结论“非 test 环境自动创建 stdout structured recorder”被本批替代为：

> composition 未显式注入 recorder 时必须 no-op；是否、如何记录由明确的上层集成者决定。低层 recorder 没有默认目的地。

### 4.3 相邻但不扩范围的问题

`migration/ohbaby-home.ts` 中无条件 `process.emitWarning` 也会写向用户终端。它与 command record 污染在 surface 层相似，但来源、语义与验收对象不同。本批只在现状文档记录，不连带修改。

## 5. 参考原则

- **信息隐藏 / DIP**：recorder 负责队列与投递，不决定终端目的地。
- **KISS / YAGNI**：保留两个本地 no-op，拒绝无调用方 options 与 debug 分支。
- **显式依赖**：需要 record 的集成者必须注入 sink/recorder，并拥有其生命周期。
- **同环境行为一致**：production/test 不再采用相反的默认策略。
- **分层验证**：unit 证明合同，composition test 证明装配，process test 证明真实 stream。

## 6. 用户确认与评审收敛记录

- 2026-08-28：用户确认本批先不建设 log/debug 日志系统，只修复终端污染 Bug。
- 2026-08-28：用户澄清正式形态只有 in-process TUI 与 `ohbaby serve` Web。
- 2026-08-28：第一轮子代理确认根因和“目的地决策上移”方向，同时指出早期方案存在公开 factory 无内部调用方、无调用方 options、人工 review 门等问题。
- 2026-08-28：外部复核进一步指出接入 `OHBABY_DEBUG`、SDK 共享 no-op、宽泛 lint 都属于不必要扩张。
- 2026-08-28：最终收敛并获用户确认：不接 debug、不加 options、不加共享 singleton；保留本地 no-op；采用精确 lint、production 子进程回归与显式生命周期合同，随后进入实施和独立验收。
