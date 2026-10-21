# 2. 优化方案与改动面

> 本文是实施契约。2026-10-21 已按 `main@73e065e7` 复核，实施分支为 `codex/llm-package-extraction`。前置的 [sdk 与 server 结构整理](../../2026-10-21-sdk-server-boundaries/README.md) 已完成；§2.9 保留规划时的行号，实施按符号定位。以下路径若无特别说明，都相对于 `packages/ohbaby-agent/src/`。

> §2.2 中“日志”“agent 公开导出”“发布”三行是规划时推导的决定，随本文一起提交用户审查（见 00 §2 末尾的说明）。

## 2.1 方案总览

先在 agent 内部把耦合解开，再搬家，最后补齐构建与发布。这样第二步就是纯粹的文件移动，出问题时容易判断是解耦合错了还是搬家错了。

1. **Stage 1：在 agent 内解耦。** 不建新包。做完后，三块代码（`core/llm-client/`、`services/interface-providers/`、`config/llm/` 的三个纯文件）除了互相引用和第三方库之外，不再引用 agent 的任何其他部分，也不引用 `ohbaby-sdk`。
2. **Stage 2：建包并搬家。** 新建 `packages/ohbaby-llm`，用 `git mv` 移入代码和测试，更新 agent 内的 import 和根配置。
3. **Stage 3：构建、发布与文档。** 打包配置、发布顺序、脚本路径、模块文档。

```
packages/ohbaby-llm/
├── package.json        依赖：openai、@anthropic-ai/sdk、zod
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts        唯一公开入口
    ├── client/         原 core/llm-client/（不含读配置的 createLLMClient）
    ├── providers/      原 services/interface-providers/（不含 reasoningCapabilityView）
    └── config/         原 config/llm/ 的 types.ts、validation.ts、model-profile.ts

packages/ohbaby-agent/src/
├── core/llm-client/
│   ├── create-llm-client.ts   读配置 → 调用 ohbaby-llm，接日志
│   └── index.ts               导出 createLLMClient 及其选项类型
├── config/llm/                只剩 IO 部分，类型和校验从 ohbaby-llm 引入
└── services/llm-model/
    └── reasoning-view.ts      reasoningCapabilityView
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 实施顺序 | 先解耦、再搬家 | 每步可单独验证；Stage 1 完成后用 `rg` 就能确认边界 | 一次性建包并修所有编译错误 | 多一个阶段 |
| `config/llm` 的纯部分 | `types.ts`、`validation.ts`、`model-profile.ts` 整个文件搬走 | 三个文件都是纯的，只互相引用（01 §1.3.4）；整文件搬比按函数拆简单 | 只搬推理相关的几个函数 | `ohbaby-llm` 里会有 `validateModelJson` 等暂时只被 agent 使用的函数 |
| 构造函数 | `ohbaby-llm` 导出 `createLLMClientFromConfig(config, options)`，同步返回 | 调用方给配置，包内不碰文件和环境变量 | 让包内接收一个 config loader 回调 | agent 多一个包装文件 |
| agent 的 `createLLMClient` | 原名、原签名保留，移到 `core/llm-client/create-llm-client.ts` | 唯一的生产调用方（`ui-inprocess.ts:2448-2450`）和测试注入点不用改 | 让调用方自己读配置 | 无 |
| 日志 | 构造函数的选项接收 `tokenUsageReporter`，原样传给 provider；agent 包装层在回调里调用 `emitDiagnostic` | provider 本来就是这个回调接口；包内无需知道日志系统 | 在包内定义一个 Logger 接口 | 无 |
| `reasoningCapabilityView` | 移到 agent 的 `services/llm-model/reasoning-view.ts`；调用方直接引入这个文件，不经过 `llm-model` 的 index | 它输出 sdk 的 UI 类型，属于适配逻辑。`config/llm/apply-active-model-config.ts` 已经依赖 `llm-model`；`adapters/ui-inprocess.ts` 目前不依赖它，但 adapters 依赖 services 是正常方向。`llm-model` 对 config 只有类型引用，不会成环 | 放 `adapters/` | config 引用 adapters 会是反向依赖 |
| `scopedSessionKey` | 在 `client/prompt-cache.ts` 内保留一份私有编码函数 | 缓存键格式必须冻结；agent 里同名函数用于内存键，两者可以各自演化 | 把 `utils/scoped-session.ts` 搬进 `ohbaby-llm` | 3 行重复；用测试钉住输出 |
| `InterfaceProviderKind` | 只保留 `config/types.ts` 一份，`providers/types.ts` 从它引入 | 消除重复 | — | 无 |
| agent 内部引用 | 全部直接从 `"ohbaby-llm"` 引入 | 一眼能看出代码归属；避免 agent 里留一层转发 | 在 agent 保留 `core/llm-client/index.ts` 全量转发 | 约 50 个文件改 import |
| agent 公开导出 | `index.ts` 用显式名单继续导出原来 `core/llm-client/index.ts` 导出的全部名字，除 `createLLMClient`、`CreateLLMClientOptions` 继续来自 agent 包装层，其余来源改为 `ohbaby-llm`；不导出 `createLLMClientFromConfig` | server、cli 和外部用户不受影响；显式名单避免把 `ohbaby-llm` 的 `ConfigError` 等名字通过 `export *` 带出来，与 `config/index.js` 的同名导出冲突 | `export * from "ohbaby-llm"`；删掉这些导出 | agent 的公开接口暂时比必要的宽；是否收窄另议 |
| 包内目录 | `client/`、`providers/`、`config/` 三个子目录 | 对应原来的三个来源，读者容易对照 | 平铺 | 无 |
| 每个 provider 单独成包 | 不做 | 只有三种协议 | dsh 的做法 | 无 |
| 发布 | 公开发布，版本与其他包同步 | `ohbaby-agent` 是公开包，它的依赖必须能从 npm 装到 | 用 tsup 把它打进 agent | 打进 agent 就失去了独立复用的意义，也和现有的“各包 external”做法不一致 |

## 2.3 分阶段实施

### Stage 1：在 agent 内解耦

**目标**：不建新包、不移动文件位置，只消除对外耦合。行为不变。

**做法**：

1. **拆分 `createLLMClient`。** 在 `core/llm-client/client.ts` 中新增 `createLLMClientFromConfig(config: LLMConfig, options?: { tokenUsageReporter?: ... }): LLMClientInstance`，内容是原函数 L61 之后“创建 provider、组装实例”的部分。新建 `core/llm-client/create-llm-client.ts`，放原来的 `createLLMClient` 和 `CreateLLMClientOptions`：调用 `getLLMConfig`，构造 `tokenUsageReporter`（内部调用 `emitDiagnostic`），再调用 `createLLMClientFromConfig`。做完后 `client.ts` 不再引用 `config/index.js` 的值、`observability/*` 和 `node:path`。`llm-client.test.ts` 在文件级 mock 了 `config/index.js`：只验证配置读取和诊断日志的用例改为测 `create-llm-client.ts`；其余用例改为直接调用 `createLLMClientFromConfig` 并传入测试配置，去掉对 mock 的依赖。这一步要改写测试，但每个用例的断言不变。
2. **移走 `reasoningCapabilityView`。** 从 `services/interface-providers/reasoning.ts:478` 移到 `services/llm-model/reasoning-view.ts`，`reasoning-view.unit.test.ts` 随之移动。它用到的 `orderedReasoningEfforts`、`defaultReasoningEffort` 等函数留在 `reasoning.ts` 并保持导出。更新 `adapters/ui-inprocess.ts:41` 和 `config/llm/apply-active-model-config.ts:2` 的 import，直接引入 `reasoning-view.ts`。做完后 `reasoning.ts` 不再引用 `ohbaby-sdk`。
3. **私有化缓存键编码。** `prompt-cache.ts` 不再引用 `utils/scoped-session.js`，改用文件内私有函数，逻辑与 `scopedSessionKey` 完全相同。先补测试：对几组固定的 `sessionId` 和 `contextScopeId`（包括需要 URI 编码的字符）断言 `createScopedPromptCacheKey` 的输出，测试在改动前后都必须通过。
4. **合并 `InterfaceProviderKind`。** 删除 `services/interface-providers/types.ts:5` 的定义，改为从 `config/llm/types.js` 引入并 re-export。
5. **把对 `config/index.js` 的类型引用改指 `config/llm/types.js`。** `core/llm-client/types.ts:16`、`prompt-cache.ts:2` 引用的 `LLMConfig`、`PromptCachePolicy` 直接从 `config/llm/types.js` 引入。

**完成定义**：

- 在 `core/llm-client/`、`services/interface-providers/`、`config/llm/{types,validation,model-profile}.ts` 的非测试文件里，相对 import 只指向这三块内部；没有 `ohbaby-sdk` 的引用。检查方法见 04 S1-1。
- `pnpm run typecheck`、`lint`、`test` 通过。
- 04 S1-2 的缓存键测试通过。

### Stage 2：建包并搬家

**目标**：代码进入 `packages/ohbaby-llm`，agent 改为依赖它。

**做法**：

1. 新建 `packages/ohbaby-llm`。`package.json`、`tsconfig.json`、`tsup.config.ts` 参照 `ohbaby-sdk`。`engines` 与 agent 一致（`node >=24`），`files` 的排除规则与其他包一致。依赖：`openai`、`@anthropic-ai/sdk`、`zod`，版本与 agent 当前一致。
2. 用 `git mv` 移动：
   - `core/llm-client/` 除 `create-llm-client.ts` 外 → `src/client/`
   - `services/interface-providers/` → `src/providers/`
   - `config/llm/{types,validation,model-profile}.ts` → `src/config/`
   - 测试文件按下表处理。原则：只引用这三块内部的测试随源文件移动；引用 agent 其他模块的测试留在 agent，改为从 `ohbaby-llm` 引入被测代码。

     | 测试 | 去向 | 原因 |
     |---|---|---|
     | `core/llm-client/` 的 8 个单测、`stream-idle.integration.test.ts` | `ohbaby-llm/src/client/` | 只依赖包内 |
     | `llm-client.test.ts` 中直接调用 `createLLMClientFromConfig` 的用例（Stage 1 改写后） | `ohbaby-llm/src/client/` | 只依赖包内 |
     | `llm-client.test.ts` 中测 `createLLMClient` 包装层的用例 | 留在 agent `core/llm-client/` | 依赖 `config/index.js` |
     | `core/llm-client/sdk-retry.integration.test.ts` | 留在 agent `core/llm-client/` | 引用 bus、adapters、context、message |
     | `services/interface-providers/` 的 7 个单测（`reasoning-view` 已在 Stage 1 移走）、`anthropic.test.ts`、`openai-compatible.test.ts`、`index.test.ts` | `ohbaby-llm/src/providers/` | 只依赖包内 |
     | `anthropic-native.integration.test.ts`、`openai-compatible-native.integration.test.ts` | `ohbaby-llm/src/providers/` | 深层引用 `client/streaming.js`、`client/types.js`，两者同在包内 |
     | `openai-responses.integration.test.ts` | 留在 agent，建议放 `core/lifecycle/` | 引用 bus、context、lifecycle、message |
     | `prompt-cache-wire.contract.test.ts` | 留在 agent，建议放 `core/context/` | 引用 message、system-prompt、goals、config |
     | `config/llm/__tests__/` 中只测纯函数和校验的测试 | 实施时逐个判断：只引用 `types`、`validation`、`model-profile` 的移到 `ohbaby-llm/src/config/`，其余留在 agent 并改 import | 该目录混有 IO 测试 |

     搬完后用 04 S2-1 的命令检查，`ohbaby-llm` 中不能出现越界引用。
3. 写 `src/index.ts`。导出名单不要凭记忆写，按 agent 现在的深层引用推出来：先在 agent 的 `src/` 下列出所有指向这两个目录的 import 及其引入的名字（例如 `rg -o '(interface-providers|core/llm-client)/[a-z-]+\.js' --glob '!core/llm-client/**' --glob '!services/interface-providers/**'`，再看每处引入了哪些名字），确保它们都能从 `ohbaby-llm` 引入。已知原 index 没有导出、必须补上的有 01 §1.3.5 列出的 13 个名字，以及 `orderedReasoningEfforts`、`defaultReasoningEffort`。另外导出 `config/` 的类型和函数，以及 `createLLMClientFromConfig`。
4. 配置：
   - 根 `tsconfig.json` 的 `references` 在 agent 之前加 `./packages/ohbaby-llm`。
   - `tsconfig.base.json` 的 `paths` 加 `"ohbaby-llm": ["packages/ohbaby-llm/src/index.ts"]`。
   - `vitest.config.ts`、`vitest.e2e.config.ts` 的 alias 加 `ohbaby-llm`。
   - agent、server、cli 的 `tsconfig.json` references 加 `../ohbaby-llm`；web 的 `tsconfig.json` 加 `../../packages/ohbaby-llm`。这几个都是 composite 项目，通过 `paths` 解析到新包源码，缺少引用会报 TS6307。
   - `eslint.config.js` L66-69 的后端规则块加上 `packages/ohbaby-llm/src/**`。
   - agent 的 `tsup.config.ts` 若有 `external` 名单，加上 `ohbaby-llm`，与 sdk 的处理一致。
   - 打包相关测试：`tests/integration/cli/packaging-smoke.integration.test.ts`（L686-720）的构建 filter、pack 调用和本地 registry 注册均加 `ohbaby-llm`；`tests/integration/compiled-model-contract.integration.test.ts`（L161、L174）构建和链接的包名单加 `ohbaby-llm`。
5. agent 的 `package.json`：`dependencies` 加 `"ohbaby-llm": "workspace:*"`。`openai`、`@anthropic-ai/sdk` 如果只剩 `utils/network-proxy/fixtures/sdk-proxy.fixture.ts` 使用，移到 `devDependencies`。`zod` 保留，agent 其他地方也在用。
6. agent 内部 import：所有引用这三块的文件改为 `from "ohbaby-llm"`，包括 01 §1.3.4 列出的 13 个 config 之外的引用方和 `config/llm/__tests__/` 中留下的测试。`config/llm/` 剩下的文件、`config/index.ts` 中对 `ConfigError` 等的导出改为从 `ohbaby-llm` 引入再导出。
7. agent 的 `index.ts:94`：把 `export * from "./core/llm-client/index.js"` 改为显式导出原来那份名单：`createLLMClient` 和 `CreateLLMClientOptions` 来自 agent 包装层，其余来自 `ohbaby-llm`。用显式名单而不是 `export *`，避免和 `config/index.js` 的 `ConfigError` 等重名导出冲突。
8. `tests/` 下引用这两个目录的文件改路径；同时更新 server 的 `runtime/daemon/goal-execution.e2e.test.ts`、`model-idle.e2e.test.ts`、`sqlite-contention.integration.test.ts`，并为 server 增加测试所需的 `ohbaby-llm` 开发依赖。消费者检查覆盖全部 `packages/` 与 `tests/`。

**完成定义**：

- `packages/ohbaby-llm/package.json` 的 `dependencies` 中没有 `ohbaby-` 开头的包。
- agent 中 `core/llm-client/` 只剩 `create-llm-client.ts`、`index.ts`，以及留在 agent 的测试（`llm-client.test.ts` 的包装层部分、`sdk-retry.integration.test.ts`）；`services/interface-providers/` 不存在。
- 对比改动前后 `ohbaby-agent/dist/index.d.ts` 的导出名清单，旧名字全部还在（见 04 S2-2）。
- `pnpm run preflight` 通过。

### Stage 3：构建、发布与文档

**目标**：`ohbaby-llm` 能和其他包一起打包、发布，文档与代码一致。

**做法**：

- 根 `package.json` 的 `build` 脚本已用 `--filter "./packages/**" --sort`，新包会按依赖顺序自动参与构建；确认一下即可。
- 发布流程：公开包由四个变成五个，顺序为 `ohbaby-sdk`、`ohbaby-llm`、`ohbaby-agent`、`ohbaby-server`、`ohbaby-cli`（`ohbaby-llm` 不依赖 sdk，与 sdk 的先后可以互换，统一放第二）。更新 `docs/ohbaby-server/package-build.md` §7 和 `docs/ohbaby-cli/tui-productization/npm-packaging.md`。下一次发布说明（`docs/releases/`）写明新增了这个包。
- 脚本路径：`scripts/run-real-network-smoke.mjs:7` 改为引用 `packages/ohbaby-llm/src/providers/index.ts`；`scripts/run-improve41-title-samples.mts` 的 L13（`InterfaceProviderStreamEvent`）改为从 `ohbaby-llm` 引入；L6 的 `createLLMClient` 和 L7 的 `reloadLLMConfig` 都保留在 agent，路径不改。
- 模块文档：见 §2.9 的 D 项。

**完成定义**：

- 五个公开包的 `pnpm pack` 通过，tarball 中没有残留的 `workspace:`，`ohbaby-agent` 的依赖里有 `ohbaby-llm` 的具体版本。
- 在独立目录从打好的 tarball 安装 `ohbaby-cli`，`ohbaby --version` 正常（见 04 S3-2）。
- 文档 D 项全部更新。

## 2.4 按包和目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-llm/` | 整个包 | — | — | Stage 2 |
| agent `core/llm-client/` | `create-llm-client.ts` | `client.ts`（Stage 1）、`index.ts` | 其余文件移走 | Stage 1、2 |
| agent `services/interface-providers/` | — | `reasoning.ts`、`types.ts`（Stage 1） | 整个目录移走 | Stage 1、2 |
| agent `services/llm-model/` | `reasoning-view.ts` 及测试 | — | — | Stage 1 |
| agent `config/llm/` | — | 其余文件改 import | `types.ts`、`validation.ts`、`model-profile.ts` 移走 | Stage 2 |
| agent 其他目录 | — | 约 50 个文件改 import；`index.ts` 改导出 | — | Stage 2 |
| 根目录 | — | `tsconfig.json`、`tsconfig.base.json`、`vitest.config.ts`、`vitest.e2e.config.ts` | — | Stage 2 |
| `scripts/`、`tests/` | — | 路径 | — | Stage 2、3 |
| `docs/` | — | 见 §2.9 | — | Stage 3 |

## 2.5 接口、迁移与兼容

- **`ohbaby-agent` 的公开导出**：名字不减少、不增加，来源改变。需要 `createLLMClientFromConfig` 的使用者直接依赖 `ohbaby-llm`。
- **`createLLMClient`**：签名不变。
- **运行时行为**：不变。LLM 请求、重试、缓存键、token 统计都不改。
- **发布准备**：新增公开包的构建和打包配置，调整发布顺序。本轮只提交代码，不 merge、push 或实际发布 npm 包。
- **数据迁移**：不需要。

## 2.6 风险与回滚

| 风险 | 表现 | 防范 | 回滚 |
|---|---|---|---|
| 缓存键变化 | prompt cache 命中率骤降，费用上升 | Stage 1 先写钉住输出的测试；`prompt-cache-wire.contract.test.ts` 留在 agent，改 import 后必须通过 | revert Stage 1 第 3 步 |
| `createLLMClient` 行为变化 | 配置路径、`.env` 位置、token 用量日志丢失 | 包装层只搬原逻辑；`llm-client.test.ts` 的配置相关用例留在 agent 继续跑；04 S1-3 检查诊断事件 | revert Stage 1 第 1 步 |
| agent 公开导出丢名字 | server、cli 或外部用户编译失败 | 显式名单；04 S2-2 对比导出 | 补导出 |
| `export *` 重名 | `ConfigError` 等同时从两处导出，TS 报错或静默丢弃 | 用显式名单（Stage 2 第 7 步） | — |
| 测试遗漏在错误的包 | 搬进 `ohbaby-llm` 的测试引用了 agent，导致新包依赖 agent | 04 S2-1 检查 `ohbaby-llm` 内没有 `ohbaby-agent` 字样和越界的相对路径 | 把该测试移回 agent |
| 发布后发现包名或边界不合适 | npm 上的包名已被占用，改名要处理旧版本 | 发布前在 Stage 3 用 tarball 安装验证；第一次发布前再确认一次包名 | 已发布的版本只能 deprecate，不能真正撤回 |

## 2.7 与 00 边界对齐检查

| 00 结论 | 本文落点 |
|---|---|
| 包名 `ohbaby-llm`，收纳三块代码 | §2.1、Stage 2 |
| `config/llm` 纯部分进包，IO 留在 agent | §2.2、Stage 2 |
| 构造函数接收已解析配置；agent 保留 `createLLMClient` | Stage 1 第 1 步 |
| 日志通过回调 | §2.2、Stage 1 第 1 步 |
| `reasoningCapabilityView` 留在 agent 的 `services/llm-model` | Stage 1 第 2 步 |
| `ohbaby-llm` 不依赖 workspace 包 | Stage 2 完成定义 |
| agent 内部直接从 `ohbaby-llm` 引入，不留副本 | §2.2、Stage 2 第 6 步 |
| agent 公开导出不减少 | Stage 2 第 7 步 |
| 公开发布，顺序 sdk、llm、agent、server、cli | Stage 3 |
| `llm-model`、配置 IO、代理留在 agent；不改行为 | §2.8 |

## 2.8 不在本轮

| 项 | 原因 | 后续 |
|---|---|---|
| 收窄 `ohbaby-agent` 对 LLM 名字的再导出 | 需要先确认下游是否在用 | 后续候选 |
| `services/llm-model/` 进包 | 依赖配置，与 LLM 调用代码无互相引用 | 不计划 |
| 配置读写和网络探测进包 | 属于 agent 的 IO | 不计划 |
| 全局代理（`utils/network-proxy`）进包 | 通过 undici 全局 dispatcher 生效，LLM 代码不感知 | 不计划 |
| 每个 provider 单独成包 | 只有三种协议 | 需要单独复用某个 provider 时再议 |
| 统一中间表示、新增 provider | 与 2026-09-11 议题的冻结边界一致 | 不在本议题 |
| 修改 LLM 调用行为 | 本轮只搬代码 | — |

## 2.9 关键改动清单

> 行号是 `7bc75168` 时的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。路径相对于仓库根目录。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码 | `packages/ohbaby-agent/src/core/llm-client/client.ts` | `createLLMClient`、`CreateLLMClientOptions` | L16-32、L50-76 | 拆出 `createLLMClientFromConfig`；读配置和日志部分挪到 agent 的 `create-llm-client.ts` | 去掉 LLM 层对配置单例和日志的依赖 |
| C2 | 代码 | `packages/ohbaby-agent/src/services/interface-providers/reasoning.ts` | `reasoningCapabilityView`；sdk import | L478；L1 | 移到 `services/llm-model/reasoning-view.ts` | 去掉 LLM 层对 UI 类型的依赖 |
| C3 | 代码 | `packages/ohbaby-agent/src/core/llm-client/prompt-cache.ts` | `createScopedPromptCacheKey`；`scopedSessionKey` import | L193-200；L10 | 改用文件内私有编码函数，先补钉住输出的测试 | 缓存键变化会让 prompt cache 失效 |
| C4 | 代码 | `packages/ohbaby-agent/src/services/interface-providers/types.ts` | `InterfaceProviderKind` | L5 | 删除，从 config 类型引入 | 重复定义 |
| C5 | 代码 | `packages/ohbaby-agent/src/index.ts` | `export * from "./core/llm-client/index.js"` | L94 | 改为显式名单，来源 `ohbaby-llm`；`createLLMClient`、`CreateLLMClientOptions` 来自 agent 包装层 | agent 公开接口不变 |
| C6 | 代码 | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | `createLLMClient` 调用；`reasoningCapabilityView` import 与调用 | L2448-2450；L41、L2513-2521 | 前者不变（签名保留），后者改 import | 唯一的生产构造点 |
| C7 | 代码 | `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts`、`writer.ts` | 对 `interface-providers/reasoning` 的 import | L2；L4 | 改为从 `ohbaby-llm` 和 `services/llm-model` 引入 | 原来的环 |
| C8 | 代码 | 根 `tsconfig.json`、`tsconfig.base.json`、`vitest.config.ts`、`vitest.e2e.config.ts`；agent、server、cli、web 的 `tsconfig.json` | references、paths、alias | `tsconfig.base.json` L17-18；`vitest.config.ts` L64-69；`vitest.e2e.config.ts` L36-41 | 加入 `ohbaby-llm` | 不加则编译（TS6307）和测试解析不到新包 |
| C9 | 代码 | `tests/integration/cli/packaging-smoke.integration.test.ts`、`tests/integration/compiled-model-contract.integration.test.ts` | 包名单 | L686-720；L161、L174 | 加入 `ohbaby-llm` | 在 `pnpm test` 中运行，不改会让打包安装失败 |
| C10 | 代码 | `packages/ohbaby-agent/src/services/interface-providers/prompt-cache-wire.contract.test.ts`、`openai-responses.integration.test.ts`、`core/llm-client/sdk-retry.integration.test.ts` | 整个文件 | — | 留在 agent，改为从 `ohbaby-llm` 引入 | 搬进新包会让新包依赖 agent |
| D1 | 文档 | `docs/core/llm-client/goals-duty.md`、`architecture.md`、`dfd-interface.md`、`data-model.md`、`test.md` | 位置、依赖、非职责；`goals-duty.md` L75 | — | 改为描述 `ohbaby-llm`；修正重试的过时说法 | 模块权威文档 |
| D2 | 文档 | `docs/services/providers/` 下 `goals-duty.md`、`architecture.md`、`data-model.md`、`dfd-interface.md`、`test.md` | 路径与非职责 | — | 改为 `ohbaby-llm/src/providers` | 路径已过时 |
| D3 | 文档 | `docs/ohbaby-server/package-build.md`、`docs/ohbaby-cli/tui-productization/npm-packaging.md` | §7 npm 发布顺序 | — | 五个包，加入 `ohbaby-llm` | 发布流程依据 |

### 连带影响面（不逐行列出）

- `core/lifecycle/`、`core/context/`、`core/message/`、`core/agents/`、`runtime/`、`agents/`、`adapters/ui-runtime/`、`services/session/title-generator.ts`：import 改为 `ohbaby-llm`。
- `config/llm/` 剩下的文件和 `config/index.ts`：类型、校验、`ConfigError` 改为从 `ohbaby-llm` 引入。
- `tests/` 下 26 个文件、`scripts/run-real-network-smoke.mjs`、`scripts/run-improve41-title-samples.mts`：路径。
- 下一次发布说明（`docs/releases/`）：写明新增 `ohbaby-llm`。
- `docs/services/llm-model/tokenCounting/*` 中引用旧路径的地方。
- `config/llm/__tests__/` 中留在 agent 的测试：import 改为 `ohbaby-llm`。
