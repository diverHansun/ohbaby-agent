# 实施复盘与 review 处理

> 日期：2026-06-29  
> 范围：`/connect` 后端、CLI/TUI、Web、Server、SDK 契约与测试覆盖。

## 一、最终实现状态

- `apiKeyEnv` 与 `apiKey` 已从 `/connect` 全链路强制项改为可选项。
- 无真实 key 时，后端使用集中占位符 `not-needed` 满足 SDK 非空 key 约束；占位符不写入 `.env`，也不写入 `model.json`。
- 用户提供 `apiKey` 但未提供 `apiKeyEnv` 时，后端派生 `<PROVIDER>_API_KEY`，保持密钥进 `.env`、配置只存键名的范式。
- 本地 keyless endpoint 可保存、reload、创建 LLM client 并完成 streaming 推理回归。
- 前端不再强制校验 `apiKeyEnv` / `apiKey`，验证与鉴权失败交给后端和上游 endpoint。

## 二、Claude review 问题处理

### 1. keyless e2e 没进入默认测试入口

结论：问题成立，已修复。

原 keyless 回归文件命名为 `connect-model.keyless.e2e.test.ts`，默认 `pnpm test` 会排除 `*.e2e.test.ts`，而 CI 只跑 `pnpm test:unit`，导致最关键的 fake-server 保存、reload、stream 回归只能手动运行。

处理：

- 重命名为 `connect-model.keyless.integration.test.ts`。
- 用例文案、临时目录前缀、marker 从 `e2e` 调整为 `integration`。
- 该测试现在会被默认 `pnpm test` 与 `pnpm test:integration` 收纳。

同时补强：LLM config 目录下原本若干 plain `.test.ts` 文件改为 `*.unit.test.ts`，让 CI 的 `pnpm test:unit` 能覆盖 manager/loaders/validation/integration 单元语义测试。

### 2. 显式配置 env 名但缺值时诊断丢失

结论：问题成立，已修复为非阻断 warning。

语义区分：

- 用户完全不填 `apiKeyEnv`：这是本地 keyless 的正常路径，不提示缺 key。
- 用户显式填了 `apiKeyEnv`，但 process env 和 `.env` 都没有可用值：后端仍用占位符继续请求，让上游决定是否需要鉴权；同时返回 warning，提示 env 名已配置但未取到值。

处理：

- `resolveApiKey` 返回 `{ value, warning? }`，不再只返回字符串。
- `applyActiveModelConfig` 与 `probeActiveModelContextWindow` 合并 API-key-env warning 与 context-window probe warning。
- API key 来源采用"第一个非空值"：process env 非空优先；process env 缺失或空白时回落到 `.env` 非空值；两者都没有才使用占位符并返回 warning。
- Web 保存结果面板展示后端返回的 warning；TUI 既有保存 warning 展示保持可用。

### 3. LLM `validateApiKey` 死代码

结论：问题成立，已删除。

`config/llm/validation.ts` 中的 `validateApiKey` 在 keyless 改造后不再被生产路径调用，只剩自身测试引用。为避免保留误导性 API，已删除该函数及测试块。

注意：`config/tools/search/validation.ts` 中的同名 `validateApiKey` 仍在 search manager 中使用，本次未改动。

### 4. D2 派生 env 名逻辑轻微重复

结论：暂不抽象，保持现状。

`apply-active-model-config.ts` 与 `writer.ts` 都需要在自身边界决定是否写入/展示 `apiKeyEnv`。两处已共享 `defaultApiKeyEnvForProvider`，重复的是调用条件而不是派生算法。继续抽象会让写路径和 apply 路径产生更强耦合，当前保持更清晰。

## 三、额外覆盖调整

- Web `/connect` 保存结果新增 warning 展示单元测试。
- 后端新增"显式 env 名缺值不阻断但返回 warning"回归。
- 后端本地 keyless 单元测试使用匹配 `local-model` 的 fake metadata，确保测试真正覆盖 keyless 无 API-key-env warning 的路径。

## 四、验证记录

已完成自动化验证：

- `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/validation.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/connect-model.keyless.integration.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx --passWithNoTests`
- `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/manager.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/validation.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/connect-model.keyless.integration.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx --passWithNoTests`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run build`
- `pnpm test:e2e:snapshot`
- `pnpm exec vitest run --config vitest.e2e.config.ts --passWithNoTests`
- `git diff --check`

`pnpm test` 说明：

- 子代理修复前曾完整通过一次：231 个 test files passed，3 skipped。
- 子代理修复后，默认全仓并行 `pnpm test` 两次均只有 `tests/integration/cli/packaging-smoke.integration.test.ts` 的 `npm install -g` 超时；其余 230 个 test files 均通过。
- 该 packaging smoke 在单跑与 `pnpm test:integration` 复跑中通过，判断为本地 npm 安装/临时 registry 路径在全仓并行负载下的外部超时风险，而非本次 `/connect` 代码路径失败。

E2E 说明：

- `snapshot.e2e.test.ts` 通过。
- `connect-model.real.e2e.test.ts` 与 `llm-config.e2e.test.ts` 是真实 provider opt-in 用例，未设置 `OHBABY_CONNECT_MODEL_REAL_E2E=1` / `OHBABY_LLM_E2E=1` 时按项目设计跳过。

浏览器联动：

- 使用隔离 `HOME=/tmp/ohbaby-browser-home-Q378pR` 启动 built Web + backend。
- 使用本地 fake OpenAI-compatible server：`http://127.0.0.1:61665/v1`。
- Web `/connect` 只填写 `provider=lmstudio`、`model=browser-local-model`、`baseUrl`；`apiKeyEnv` 与 `apiKey` 均留空。
- 保存成功，页面结果显示 `interface=openai-compatible`、`context=65,536`、`source=detected`。
- 临时 `model.json` 不含 `apiKeyEnv`，未生成 `.env`。

真实 LM Studio 联动：

- 使用用户本机 LM Studio，服务地址 `http://127.0.0.1:1234`，OpenAI-compatible base URL 为 `http://127.0.0.1:1234/v1`。
- 通过 `/v1/models` 确认已加载 `qwen/qwen3.6-35b-a3b`。
- 使用隔离 `HOME=/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/ohbaby-lmstudio-home-XXXXXX.Auzomhm61o` 启动 built Web + backend。
- Web `/connect` 只填写 `provider=lmstudio`、`model=qwen/qwen3.6-35b-a3b`、`baseUrl=http://127.0.0.1:1234/v1`；`apiKeyEnv` 与 `apiKey` 均留空。
- 保存成功，页面结果显示 `interface=openai-compatible`、`context=128,000`、`source=default`，并展示 context metadata 未探测到的非阻断 warning。
- 临时 `model.json` 不含 `apiKeyEnv`，未生成 `.env`。
- 发起真实消息后 assistant 返回 `OHBABY_LMSTUDIO_E2E_OK`，并记录 token usage。
- 使用同一隔离 HOME 重启 backend 后再次发起消息，assistant 返回 `OHBABY_LMSTUDIO_RELOAD_OK`，验证无 key 配置的 reload 路径可用。

子代理审查：

- 已派发只读审查。
- P1：process env 为空会遮住 `.env` 真实值。已修复，并新增 connect/probe/manager 覆盖。
- P3：实施方案与验收文档有 D4 / `validateApiKey` 过时表述。已清理。
