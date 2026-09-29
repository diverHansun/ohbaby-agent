# 1. 现状与问题

## 1.1 调查基线

2026-09-27，已提交 HEAD 为 `3ac9a6b3`；调查对象包括当前未提交工作树。当前包含用户参与的修复，不能把这些变化归为全部由本轮实现，也不能将它们视为已验收。

未提交改动涉及 `apps/ohbaby-web/src/api/daemon/{client.ts,server-client.integration.test.ts}`、`ui/App.tsx`、新增 New session 集成测试及同步提示 hook/测试；`ohbaby-agent` 的 ui-inprocess/ui-persistent 与 prompt-scheduler stores；SDK client；server create-app、client-view、permission-access、rpc-route。实施 S0 必须逐项核对当前 diff 及未跟踪文件，不覆盖或整批丢弃。

## 1.2 问题清单与证据

以下路径相对仓库根，行号为调查快照，定位以符号为准。

| ID | 事实与风险 | 代码证据 | 回应 |
| --- | --- | --- | --- |
| P1 | UI、状态协调、存储副作用集中；拆 JSX 仍可能保留原耦合 | `apps/ohbaby-web/src/ui/App.tsx` 4864 行；ConnectedOhbabyWebApp L462、Composer L2661、StructuredCommandOverlay L3775 | 02 S2/S3；Web 02 |
| P2 | 普通点击复用通过，但刷新后的短期旧绑定仍排除空会话 | `packages/ohbaby-server/src/app/create-app.ts` disconnectClient L2571、scheduleClientRoutingCleanup L2600；`coordination/client-view.ts` sessionIdsBoundByOtherClients L420 | 02 S1 生命周期合同 |
| P3 | 空判断散落在持有 stores 的 adapter、controller 的热页候选规则和 metadata 预筛，入口语义不一致 | `ui-inprocess.ts` isAuthoritativelyEmptySession、createSessionFromCommand；`adapters/ui-inprocess/session-controller.ts` resolveSessionForNewPrompt；`commands/builtin.ts` | 02 入口矩阵与由 adapter 注入的权威谓词；热页/metadata 仅预筛 |
| P4 | 重试无界，排除参数可能被忽略；同 client 合并仅 REST 有覆盖 | `server/coordination/permission-access.ts` createOrReuseClientSession；`protocols/jsonrpc/client.ts` createSession L215 不接收 input；`rpc-route.ts` L247/L425 | 02 有界协调与接线 |
| P5 | 同 scope 无条件短路会跳过 error 态恢复 | `web/api/daemon/client.ts` acceptBinding L295–344；普通重复点击避免重启有效，错误态不能沿用 | 02 健康/恢复状态矩阵 |
| P6 | 源码、测试、CSS 均集中；现有单测未覆盖 server 断线保留窗口 | App 测试 5657 行、styles.css 3395 行；client-view unit 直接 disconnect；New session 集成 26 项 | 04 跨层回归与分离迁移 |
| P7 | runtime 与 backend client 在一个大文件；UI 消费全量能力 | `web/api/daemon/client.ts` 1732 行，两类分别 L88/L1156；App Composer 接收全量 ViewModel/client | Web 02 接口收窄与机械拆类 |

## 1.3 New session 实测与限制

2026-09-27 在隔离 SQLite、编译 CLI serve 与真实浏览器中：同客户端逐次等待 6 个 POST 完成，均返回同一空 B，DB 为 2；从已有内容 A 点 New 也复用 B。刷新后选 A 并立即 New，新建 C，DB 从 2 到 3；刷新后等待 6 秒则复用 C。快速刷新重复三轮，DB 从 3 到 5。每次刷新 clientId 不同。

源码默认保留期 5000ms：最后 SSE 断开只启动清理 timer，到期才设置 coordinator 的 disconnected 状态；所以这段窗口里没有连接的旧 client 仍排除候选。只注册而不建立 SSE 的 client 没有对应断开动作，现有注册还会取消清理 timer；JSONRPC 客户端可以持续请求却从不建立 SSE。目标合同须同时补初始宽限、按 HTTP/RPC 活跃请求刷新、断开后立即释放空候选资格，并让到期清理遵守既有 owner 合同与在途 pin。

上轮定向测试 56/56 通过仍漏此链路，不能当作最终修复证明。本机补充证据为 `.ohbaby/test-evidence/new-session-regression/followup-20260927.json`；它不是长期保证存在的仓库产物，完整可重现步骤写入 04。上述刷新场景不是“每次普通点击都失败”的复现；原始反馈、现存修复和剩余缺口必须分开记录。

## 1.4 七维基线与文档差异

| 维度 | 当前合理基础 / 缺口 |
| --- | --- |
| 目标与职责 | Web 是 SDK/backend 的消费者，不自建运行事实；空会话复用的跨入口职责尚未统一 |
| 架构 | runtime/client/store/UI 大方向成立；App 内功能边界未落实；wire.ts 同时含部分投影类型，属于存量，不借本轮全盘重排 |
| 数据 | SQLite message/run/prompt 才能证明空；标题、热页为空均不足。草稿/local attempt 是界面状态，不可覆盖服务端事实 |
| 数据流与接口 | 流式恢复、审批已有各自 generation；复用不得无条件重新 begin，也不得忽略失败恢复；JSONRPC 参数与命令输出需对齐 |
| 用例 | 项目切换、草稿、队列租约、slash、Stop 和审批都已有产品语义；拆分必须保持跨功能协调 |
| 非功能 | 优先正确性、可维护性与可测性；不以新增模块数或行数为指标；不把不明会话当空处理 |
| 测试 | 现有行为测试有价值，应先原样保留；新增 server 生命周期 + 编译浏览器 + SQLite 数量的反馈环 |

| 文档说 | 实际代码 | 本轮处理 |
| --- | --- | --- |
| `docs/ohbaby-web/architecture.md` 列 Composer/ConversationStream/StatusBar 独立文件 | 多数仍在 App 中 | 目标职责落到模块并接线；实施时同步架构文档 |
| `docs/ohbaby-web/improve-2/` 规定当前会话同源恢复 | 当前机制已被 improve-1.1 实现；该模块目录仍带历史“规划”措辞 | 本轮复用已落地机制，不重写旧规划或假定其未实施 |
| 旧 `/new` 支持明确禁止复用，区分 current/created | 工作树 daemon 分支未解析 flag，固定输出 created | 02 明确纠正；不得笼统宣称所有入口原来语义相同 |

## 1.5 SWE 判断

主要债务是功能内聚不足、异步状态归属混杂和过宽接口，不是缺框架。保留成熟事实流、分开修 bug 与结构迁移、局部小 helper 不强制独立、先保留完整行为测试，能降低回归风险。不能把 New session 缺陷伪装成目录问题；也不能为未来子会话预先创建泛型页面引擎。

后续：[02 阶段方案](02-optimization-plan-and-change-scope.md)；Web 细节：[01 模块现状](../../../ohbaby-web/improve-3/01-current-state.md)。
