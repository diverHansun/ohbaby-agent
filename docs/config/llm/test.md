# LLM 配置模块测试策略

## 测试范围

覆盖模型库读取、版本迁移、凭证解析、写入事务、有效值投影、自动发现和运行准入，并验证 SDK/HTTP/Web/TUI 的一致契约。文件系统实现和供应商是否真实执行推理不由本模块测试保证。

## 关键场景

### 正常路径

1. 仅填连接创建模型，两个覆盖字段保持省略，运行有效 context/output 为 300000/32768；effort 不影响普通输出上限。
2. 同路由检测值只写 `detectedContextWindowTokens`；手动覆盖优先。清空覆盖后回到自动，重新读取不把检测或 fallback 写回覆盖。
3. Save 先完成发布，自动发现锁外运行；context/reasoning 独立进入终态并通知。普通 Save 复用可信能力，Detect again 强制刷新自动能力。
4. 主、子代理使用同一有效配置；标题、摘要、probe 的专用额度不受普通默认影响。
5. 新 run 能力未知时立即使用 service-default，不发送 effort；已有同路由能力重探期间继续可用，失败后 identified+reason。

### 错误路径

1. Create 的 null、0、负数、小数、空字符串拒绝；Patch 的 null 清除，省略保持。connect 的 null 保留到 writer，正式 maxOutputTokens（包括 null）优先于 maxTokens 别名。
2. context 小于等于输出预留与余量时仍可保存、读取、显示 tokenBudgetIssue；仅该模型的新 run 返回 `MODEL_TOKEN_LIMITS_INCOMPATIBLE`，其他模型可运行，修正覆盖后恢复。
3. 缺失凭证引用不发送探测；key、指纹不进入模型库、状态、错误或日志。无鉴权端点保留可用性。
4. 配置写入失败不发起有效探测；credential+model 事务失败验证回滚保护。发现失败不撤销 Save。
5. 探测只有 400/422 表示不支持；429、5xx、超时、取消等为 unknown，不发布残缺档位。总期限和所有异常终态都结束动效。

### 边界情况

- 缺版本文件先展开旧格式再迁移：context→检测值、8192→无覆盖；混合格式残留顶层 maxTokens 不再继承。版本 2 的明确 8192 不迁移，其他版本拒绝。
- 读取不写盘；首次正常保存或探测写回前备份原文件并写版本 2，后续不重复备份。
- 改 provider/model/协议/base URL 清两类自动证据；只换 key、apiKeyEnv/promptCache 保留 context，重探 reasoning。手改 routeKey 不匹配时读取过滤证据。
- A→B→A、旧请求晚到、Save 后立即编辑、重新探测时修改覆盖均不覆盖新意图；无关编辑不取消在途任务。启动、列表读取和准备 run 不发起探测。
- 用户输入与检测值相同仍建立覆盖；推送保留草稿和基线。TUI 预填仅覆盖，清空发送 null，无编辑不保存，自动提示不冒充输入。
- Responses 识别 max 后可选择并实际发送，未知字符串或当前不支持的档位拒绝，普通输出仍为 32768。
- Anthropic adaptive 的 metadata/内置/显式/旧自动能力统一过滤 minimal，原始证据保留，过滤为空时 unknown。无版本和版本 2 默认偏好均在读取时清理；新显式无效 minimal 拒绝。
- Anthropic 清理读取不写盘，下一次保存持久化；Settings/current-model 均携带固定通知，Web/TUI 实际显示。probe 不清通知，失败选择不清通知，成功明确选择清除。合法 minimal→low effortMap、budget/binary 不误清理。
- 会话/单次 minimal 偏好在能力已知时拒绝；能力 unknown 时使用 service-default，wire 不含 minimal；不改历史消息或在途 run。

## 集成点测试

| 接缝 | 重点 |
| --- | --- |
| `config/llm/__tests__/model-settings-automation.integration.test.ts` | 数字迁移、有效值、清空、自动发现与缺凭证 |
| `config/llm/__tests__/anthropic-effort-migration.integration.test.ts` | D10 读取清理、下一次写入、通知生命周期、合法映射和未知请求偏好 |
| `model-entry-discovery` / `model-entry-probe` / `writer` / `config-commit` 现有测试 | 路由身份、取消与旧回包、缓存/强制刷新、事务边界 |
| `ohbaby-llm` reasoning 与 provider 测试 | D9 max 正式序列化、D10 有效档位与实际 wire、probe 状态分类 |
| `ohbaby-server` settings-global、request-helpers、create-app 测试 | Create/Patch/connect HTTP 校验与 OpenAPI 对齐 |
| `tests/integration/adapters/ui-runtime/model-settings-automation.integration.test.ts` | 公共提交路径的预算拒绝、其他模型可用、修正后恢复 |
| Web settings/composer 与 TUI connect/effort/footer 测试 | 覆盖/自动分离、脏字段、推送草稿保护、状态与通知可见 |

## 验证策略

先运行本次修改涉及的精确测试，再执行仓库 typecheck、lint、format:check、test、build。测试结果须记录实际命令和退出码，不能把计划运行写成通过。

使用独立临时 OHBABY_HOME、项目目录和本地 HTTP fixture；控制 deferred 响应、超时与状态码，结束时等待发现终态并清理数据库、环境和连接。避免并行运行会竞争 CLI package build 锁的全量套件。

真实验收覆盖三种协议的产品流式请求、工具闭环、主动 reasoning 发现及 metadata 无 context 的路由。页面流程为：仅连接 Save → 发现终态 → 手动覆盖 → 重探不覆盖 → 清空 → 关闭重开 → 实际运行并核对参数。临时模型和会话使用独立标识，结束恢复默认并清理。

完整矩阵和真实请求范围见 [improve-1 测试与验收](2026-11-12-model-settings-automation/improve-1/04-test-and-acceptance.md)。本页定义测试责任，不替代执行记录；短请求接受 32768 不等于长上下文、流式工具或 length 自动接续验收。
