# llm-client 测试与验收

## 单元与协议边界

- `core/llm-client/llm-client.test.ts`：配置绑定、流累积、工具解析、取消、重试、结束原因与 usage。
- `core/llm-client/model-snapshot.unit.test.ts`：部分工具快照、局部 index、raw 参数及不依赖凭据的多轮回传。
- `services/interface-providers/model-contract.unit.test.ts` 及三个 provider 的测试：自有请求向原生协议的直接投影、罕见字段/内容、legacy 拒绝和 Anthropic 空工具结果 fallback。
- `services/interface-providers/prompt-cache-wire.contract.test.ts`：保留实际 wire 控制字段、既有前缀行为；Responses 仍 observe-only。
- Responses unit/integration：严格事件序列、终态一致性、终态后异常/EOF、取消及禁止提前执行工具。

测试既检查流中间态，也检查最终态。只看 isComplete 或最后一段文本，不能证明工具执行门正确。

## 跨模块回归

context token-estimation 测试使用迁移前固定数值验证总量、七桶、tail、reasoning、工具来源及 composition 匹配边界。不能用新 helper 计算期望值，再用同一 helper 证明自己正确。

数据库验收检查旧字面量 Message/Part JSON，真实 close/reopen、新请求投影、新回复按旧 schema 落库，以及再次 reopen。usage 继续按旧规则每 step 只放一次，旧 metadata 可读，新写 canonical usage。

worker/stream bridge 测试区分真实 StreamingResponse 和观察事件：delta 可有文本 snapshot；wire complete 没有正文，观察事件必须缺 snapshot，不能伪造空文本或 parsed 调用。SDK DTO 的既有载荷保持不变。

## 发布入口与 E2E

`tests/integration/compiled-model-contract.integration.test.ts` 用构建产物和真实根 exports 验证新入口可编译、旧入口/字段应编译失败，并通过 loopback HTTP/SSE 完成三协议文本与工具往返。它不使用源路径 alias 或 SDK 单方法 mock，也不代替 tarball 安装、SQLite 或完整 lifecycle 验收。

`tests/smoke/responses-migration.real.e2e.test.ts` 单独使用显式开关和授权 ZenMux 凭据，覆盖生产 factory/adapter/llm-client/lifecycle/context/scheduler 文本与普通工具链。仅发送合成输入，限制请求次数和超时；失败不能通过改协议、吞掉原生状态或无限重试变成通过。普通 CI 不自动读取真实密钥。

指定模型、端点、请求预算和实际可发现测试文件的命令统一维护在 [improve-3/04](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/04-test-and-acceptance.md)。真实结果与本地测试分开记录；ZenMux 协议通过不等于官方直连或 OpenAI 原生模型兼容。

## 执行规则

每批跑定向测试、完整 unit/integration、相关 contract、lint/typecheck，并独立审查后提交。最终 preflight 和本地/真实 E2E 不沿用迁移前结果。具体运行数字、失败复测及未完成项见本轮 05 验收记录，不在本页维护另一套易漂移的计数。
