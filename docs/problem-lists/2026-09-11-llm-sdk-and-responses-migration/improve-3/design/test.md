# LLM 契约 · 模块测试

## 1. Test Scope

沿用仓库 package.json 与 scripts/run-vitest-by-type.mjs 的 unit/contract/integration 分类，不另建测试框架。覆盖本轮边界，不以覆盖率替代验收。具体执行门见 ../04。

## 2. Critical Scenarios

同一输入转换后的 wire 关键字段等价；合法与拒绝矩阵均不扩大/缩窄；参数 raw/parsed 不混用；不完整流、取消、失败及重试不误执行工具；快照正文唯一；旧估算及七类 composition 数值不漂移。

## 3. Integration Points

主/子代理和 summary/title 同一入口；MCP step tools 与 tail directives 同源；旧 SQLite fixture close/reopen → 新请求 → 新结果写旧 JSON → reopen；worker/bridge 双消费与导出按 01a 覆盖。schema 不变不足以证明 JSON 兼容。

## 4. Verification Strategy

固定基线 fixture、可控 SDK/HTTP 流用于确定性回归；真实供应商 E2E 单列模型、端点、预算和凭据来源，不使用随机回复字面值断言。不声称真实缓存命中优化，不自动重试旧会话未完成副作用。每批测试与独立审查后提交，最终完整仓库门禁。
