# 4. 测试与验收标准

> 本轮只搬代码、解耦合，验收的核心是“行为不变、边界成立”。主要依靠现有测试，只为两个高风险点新增或改写测试：缓存键和构造函数拆分。检查命令都在仓库根目录执行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| 结构检查 | 边界是否成立：`ohbaby-llm` 不引用 agent、sdk；agent 不残留旧目录 |
| 现有单元、契约、集成测试 | LLM 请求、流处理、重试、缓存字段、token 统计 |
| 新增或改写的单元测试 | 缓存键输出固定；`createLLMClient` 包装层仍会读对配置、发出 token 用量诊断事件 |
| 打包验证 | 现有的打包冒烟测试覆盖五个包；手工安装启动 |
| 真实网络冒烟（可选） | 用真实 key 跑一次已有的 smoke，确认调用和缓存命中正常 |

## 4.2 关键场景与用例

### Stage 1

**S1-1 解耦后边界成立。** 第一条命令列出两个目录对外的相对引用，结果只能指向 `core/llm-client/`、`services/interface-providers/`、`config/llm/{types,validation,model-profile}.js`。第二条检查三个 config 文件，结果只能是它们之间的 `./` 引用，不会出现 `../`，所以应当没有输出。第三条没有输出：

```bash
cd packages/ohbaby-agent/src
rg -n 'from "\.\./\.\./' core/llm-client services/interface-providers --glob '!*.test.ts' --glob '!create-llm-client.ts'
rg -n 'from "\.\./' config/llm/types.ts config/llm/validation.ts config/llm/model-profile.ts
rg -n 'ohbaby-sdk' core/llm-client services/interface-providers --glob '!*.test.ts'
```

**S1-2 缓存键不变（新增）。** 对固定输入（普通 ID；带 `::`、空格、中文的 ID；有无 `contextScopeId`）断言 `createScopedPromptCacheKey` 的完整输出。这个测试在 Stage 1 改动之前写好并通过，改动后仍然通过。

**S1-3 包装层行为不变（改写）。** `llm-client.test.ts` 按 02 Stage 1 第 1 步改写后：包装层用例断言 `getLLMConfig` 收到的 `projectDirectory` 和 `envPath` 与改动前一致，并用记录型 logger 断言收到 `tokenUsageNormalization` 诊断事件；其余用例通过 `createLLMClientFromConfig` 运行，断言不变。

**S1-4 `reasoningCapabilityView` 行为不变。** `reasoning-view.unit.test.ts` 移到 `services/llm-model/` 后通过。

### Stage 2

**S2-1 新包没有越界依赖。** `packages/ohbaby-llm/package.json` 的依赖中没有 `ohbaby-` 开头的包；下面的命令没有输出（同时检查源码和测试）：

```bash
rg -n 'ohbaby-agent|ohbaby-sdk|from "(\.\./){3,}' packages/ohbaby-llm/src
```

**S2-2 agent 公开导出名完全一致。** agent 的 `index.ts` 有多处 `export *`，不能直接比对文本。用临时脚本（TypeScript compiler API 的 `checker.getExportsOfModule()`）列出 `packages/ohbaby-agent/src/index.ts` 的全部导出名，改动前后对比：改动前后名字完全一致；`createLLMClient`、`CreateLLMClientOptions` 来自 agent 包装层，不新增 `createLLMClientFromConfig`。

**S2-3 agent 不残留旧代码。**

- `packages/ohbaby-agent/src/services/interface-providers/` 不存在。
- `packages/ohbaby-agent/src/core/llm-client/` 只有 `create-llm-client.ts`、`index.ts`、`llm-client.test.ts`（包装层部分）、`sdk-retry.integration.test.ts`。
- `packages/ohbaby-agent/src/config/llm/` 中没有 `types.ts`、`validation.ts`、`model-profile.ts`。

同时检查 `packages/` 和 `tests/` 中的旧路径引用，包括 server 的三处 daemon 测试，确认消费者已迁移到包入口。

**S2-4 wire 层缓存字段。** `prompt-cache-wire.contract.test.ts` 留在 agent，改为从 `ohbaby-llm` 引入后通过。

**S2-5 provider 与客户端行为。** 移入 `ohbaby-llm` 的单测和 `anthropic-native`、`openai-compatible-native`、`stream-idle` 集成测试在新包中通过；留在 agent 的 `openai-responses.integration.test.ts`、`sdk-retry.integration.test.ts` 通过。

**S2-6 agent 主链路。** agent 的 lifecycle、context、title-generator 相关测试通过；`config/llm/__tests__/` 全部通过；`tests/integration` 全部通过。

### Stage 3

**S3-1 打包。** `tests/integration/cli/packaging-smoke.integration.test.ts` 和 `tests/integration/compiled-model-contract.integration.test.ts` 在加入 `ohbaby-llm` 后通过。人工检查五个包的 tarball：没有 `workspace:` 残留；`ohbaby-agent` 的 `dependencies` 含 `ohbaby-llm` 的具体版本；`ohbaby-llm` 的 tarball 不含测试声明文件。

**S3-2 安装与启动。** 在独立目录用五个 tarball 安装 `ohbaby-cli`，`ohbaby --version`、`ohbaby --help` 正常。

**S3-3 脚本路径。** 下面的命令只剩 `scripts/run-improve41-title-samples.mts` 中对 `core/llm-client/index.js`（`createLLMClient` 仍在 agent）的引用：

```bash
rg -n 'core/llm-client|interface-providers|config/llm/(types|validation|model-profile)' scripts
```

**S3-4 真实调用（可选）。** 有真实 key 时跑一次 `pnpm test:smoke:real` 或对应的 cache smoke，结果与改动前一致。

## 4.3 用例与 Stage 对照

| Stage | 用例 |
|---|---|
| Stage 1 | S1-1 至 S1-4 |
| Stage 2 | S2-1 至 S2-6 |
| Stage 3 | S3-1 至 S3-3；S3-4 有条件时执行 |

## 4.4 集成边界

- **agent → ohbaby-llm**：只通过包入口。S2-1、S2-3 保证。
- **agent 公开接口 → server、cli**：S2-2 保证名字不少。
- **配置 → LLM 客户端**：由 agent 的 `createLLMClient` 读取后传入。S1-3 保证。
- **全局代理 → SDK 客户端**：不受影响。S3-4 在有代理的环境下可顺带确认。

## 4.5 回归清单

- 启动 TUI 和 Web，能和模型正常对话，流式输出、工具调用、推理内容显示正常。
- 三种协议（openai-compatible、openai-responses、anthropic）各跑一次对话。
- `/connect` 切换模型后，推理能力选项显示正确（`reasoningCapabilityView` 的使用方）。
- 上下文压缩、会话标题生成正常（两者都直接调用 `streamResponse`）。
- footer 的 token 用量和缓存命中显示与改动前一致。

## 4.6 验收标准

| 项 | 标准 | 如何验证 |
|---|---|---|
| 全量检查 | `pnpm run preflight` 通过 | 命令 |
| 各 Stage | 4.3 中对应用例全部通过 | 见 4.2 |
| 回归 | 4.5 全部手工确认 | 实施会话记录在 05 |
| 文档 | 02 §2.9 的 D1-D3 及连带文档已同步 | 人工检查 |
| 发布 | 第一次带 `ohbaby-llm` 的发布由用户确认后执行 | 发布说明 |

## 4.7 对抗性审查要点

| 攻击面 | 可能出的问题 | 防御 | 残余风险 |
|---|---|---|---|
| 缓存键 | 编码函数复制时少了 `encodeURIComponent` 或分隔符，键全部变化 | S1-2 在改动前先写好 | 低 |
| 配置读取位置 | 拆分 `createLLMClient` 时漏掉 `projectDirectory` 默认值或 `.env` 路径的拼接，导致读错配置 | 包装层整段搬移；S1-3 断言入参 | 中。审阅时逐行对照原函数 L50-60 |
| 导出缺失 | `ohbaby-llm` 的 index 少导出某个 agent 深层引用的名字，编译报错 | 按 02 Stage 2 第 3 步从实际引用推出名单 | 低（编译期就会暴露） |
| 导出冲突 | agent 的 `index.ts` 用 `export *` 带出 `ohbaby-llm` 的 `ConfigError`，与 `config/index.js` 的同名导出冲突 | 显式名单 | 低 |
| 测试搬错包 | 搬进新包的测试引用了 agent，让新包对 agent 产生依赖 | 02 Stage 2 第 2 步的去向表；S2-1 同时检查测试文件 | 低 |
| 编译配置遗漏 | server、cli、web 的 tsconfig 没加新包的引用，报 TS6307 | 02 Stage 2 第 4 步；`pnpm run typecheck` | 低 |
| 发布顺序 | 先发 agent、后发 llm，用户安装时找不到依赖 | 发布顺序写进 `package-build.md`；S3-1、S3-2 | 发布当天仍可能操作失误，按文档顺序执行 |
