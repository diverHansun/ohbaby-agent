# 4. 测试与验收契约

> 规划期标准，不是测试结果。遵循仓库 [docs-test](../../../../docs-test/README.md) 的分类、目录、fake 边界及执行规则；命令以当前 package.json/Vitest 配置核对。本轮不重建项目测试体系。

## 4.1 范围和方法

- unit：normalizer、metadata、aggregate、校准公式/过滤、estimator 的局部行为。
- integration：真实 adapter/llm-client/Lifecycle/ContextManager/message 的配对；真实 SQLite reopen；worker/bridge 和辅助请求隔离。
- contract：公开 DTO、cache wire，证明本轮没有变化。
- real E2E：沿用既有三协议 runner，只检查实际用量链和工具往返，不评估精度、价格、cache 命中改善或官方直连兼容。

新增局部用例放源码旁；新增跨模块文件为 `tests/integration/core/usage-calibration.integration.test.ts`。沿用历史 real runner `.real.e2e.test.ts` 的显式 opt-in 例外，不批量重命名旧测试。常规测试不得读 .env 或发送真实 LLM 请求。

## 4.2 验收矩阵

| ID / 合同         | 场景与必须断言                                                                                                                                                  | 文件/证据入口                                                                                                  | 批次   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| T1 / K2           | Chat、Responses、Anthropic 固定原生 usage 归一后，input inclusive、total 和明细不双算；缺失、显式零、损坏明细、累计 delta 保持旧规则                            | 既有 provider token-usage/responses-token-usage unit；新增 usage-calibration integration 串三协议              | A      |
| T2 / K1           | 两步的原始估算和 usage 各不同，各配各的；同 Step overflow 后 B 的 usage 配 B 估算；请求测量/发送同源，无附加工具结果倒灌                                        | lifecycle.unit 补断言；新增 usage-calibration integration；既有 context-improve-4-1                            | A      |
| T3 / K3/K4        | 完成缺 usage 与未完成退出分开；首步缺失后后续已知不会恢复 complete；先已知后下一步失败按原样保留；usage 已处理后 abort/length 保持时机                          | lifecycle.unit 补用例；token-usage.unit 复用                                                                   | A      |
| T4 / K4           | EMA/clamp/过滤和更新次数保持；校准确实调用原实现，下一次 prepared 可观察到同样的系数效果，不只检查 spy                                                          | manager.unit；新增 usage-calibration integration                                                               | A/B    |
| T5 / K4/K6        | 两个 session、同 session 不同 scope 隔离；disposeScope 只清目标；disposeSession 清会话；不新增每 Run 重置                                                       | manager.unit；context-subagent-scope integration；必要补缺口                                                   | A/B    |
| T6 / K5           | text/tool/hybrid 每步最多一个 Part 带 usage；纯 reasoning/无承载 Part 不伪造；缺 usage 不造零；writer 深拷贝、reader 合法总量保留/legacy fallback               | metadata.unit、lifecycle.unit                                                                                  | A      |
| T7 / K5/K6        | 旧字面量 metadata 经真实 SQLite close/reopen 后由生产 reader 可读，新 canonical roundtrip；worker/bridge 字段和值保持、summary/title 不进 agent-step 样本或累计 | database-store.integration；token-usage-roundtrip/auxiliary-token-usage-isolation integration                  | A/C    |
| T8 / K2/K7        | cache 请求控制、session 命中计算及 DTO 不变；窗口分母、总量和七桶不变，不能强制桶和等于校准总量                                                                 | prompt-cache-wire.contract、prompt-cache-usage.unit/contract、context-window-usage.unit、token-estimation.unit | A/C    |
| T9 / K8           | 只有封闭表参数名改变；函数参数顺序/数量、公开 types/exports/DTO 保持；无新运行时依赖、网络调用、schema、Map 或事件                                              | 生产 diff 审查、rg、typecheck、compiled-model-contract.integration                                             | B/C    |
| T10 / K7          | 固定输入/初态/事件序列下，旧材料、原始估算、系数序列、占用、预算、压缩判断一致                                                                                  | token-estimation.unit、tokenCounting.unit、manager.unit、context-improve-4-1 integration；基线字面量证据       | B/C    |
| T11 / 全部        | 所有定向、unit/integration/相关 contract 及最终 preflight 通过，构建消费者可用                                                                                  | §4.5 命令、exit code、日志和实际提交 SHA                                                                       | 每批/C |
| T12 / K1/K2/K5/K6 | 三协议真实文本+单工具往返；逐步 prepared 与校准入参配对；单步 usage 与 Run 已知小计一致；可承载 Part 的 metadata 一次且相等                                     | 扩展既有 real runner；§4.6                                                                                     | C      |

“已有”不代表所有组合已覆盖。实施 A 要把复用的测试名称及新增断言映射到 T 项；不能只报文件通过数。新增保护测试允许在基线就绿；生产行为修复必须先获新授权，再遵循 docs-test 的先失败测试规则。

## 4.3 关键断言设计

### 配对与校准

- 两步样本使用不同的正估算和有效 usage，且让“错误配累计”“错误配已校准占用”得出不同结果，避免 fixture 偶然掩盖错误。
- overflow 测试中准备 A/B 的消息和 tools 至少一项不同，估算也不同；最终响应带有效 usage。断言只有实际成功结果对应的校准调用，分母为 B。
- 对真实 ContextManager 的观察可用测试侧委托包装公开方法，记录入参后调用绑定好的原方法；不 mock 被测算法，不新增生产 test-only API。
- 验证下一次 prepare 的公开输出能体现原系数效果；不读取私有 Map。使用同 scope 的固定输入，排除历史变化造成的混淆。
- invalid 输入单元测试保护现有 guard，不自行增加负值、零值、缓存阈值筛选。

### 三种完整性

- finalEvent 无 usage：aggregate 得已知小计和 false，单步 metadata/校准缺席。
- 无 finalEvent 或异常退出：受控返回断言原有累计；未分类异常断言原样 rejection，不要求返回 LifecycleResult，不强制额外聚合 undefined。`usageComplete` 不是所有尝试的完整性证明。
- 明细缺失/observed false 与明确 observed true 的零值分开断言；总量有效时不因明细缺失删除总量。
- 不把 Responses incomplete、length、abort、网络 EOF 合成一个 fake 状态；按对应 adapter/llm-client/lifecycle 既有路径选 fixture。

### 存储与数值冻结

- 历史数据用字面量 JSON 写入，不用新 creator 生成后称作 legacy。执行真实 close/reopen 后调用 production reader。
- 不要求所有运行时 usage 都有持久化 Part，不要求 Run 总量永远等于历史 metadata 总和。
- 固定数值期望来自改造前确认的字面量/历史测试，不调用被测 estimator 生成自己的期望。
- `Math.round(sentHeuristic * factor)` 的行为验证可以与独立固定 estimator fixture 组合，但不能因此省略后者。

## 4.4 集成边界与误差归因

外部网络使用确定性的 transport fake/loopback，三协议 adapter、llm-client 和 context 校准保持真实。不要只在 fake provider 直接返回 canonical usage 后就宣称已覆盖原生协议归一。

既有 worker/bridge 测试使用 fake Lifecycle，证明传输而非真实校准；既有 live 使用内存 store 和测试 TokenCounter，证明生产编排而非 SQLite/估算准确度。T1/T2、T7、T10、T12 分别补齐这些边界，结果分项记录。

测试失败分成产品合同、测试/安装环境、外部网络/模型三类；需要证据才能归类。任一必选门缺失或失败不得写“整体验收通过”，不能用 skip、延长超时、删除断言、更换协议让结果变绿。

## 4.5 本地命令与门禁

在仓库根执行。新增文件实施后必须被发现，不能把 `--passWithNoTests` 的成功当作 T 项通过。

```sh
# A/B 主要单元与数值保护（均为现有文件）
pnpm exec vitest run \
  packages/ohbaby-agent/src/services/interface-providers/token-usage.unit.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/responses-token-usage.unit.test.ts \
  packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts \
  packages/ohbaby-agent/src/core/lifecycle/token-usage.unit.test.ts \
  packages/ohbaby-agent/src/core/context/manager.unit.test.ts \
  packages/ohbaby-agent/src/core/context/token-estimation.unit.test.ts \
  packages/ohbaby-agent/src/core/context/context-window-usage.unit.test.ts \
  packages/ohbaby-agent/src/core/message/token-usage-metadata.unit.test.ts \
  packages/ohbaby-agent/src/services/llm-model/tokenCounting.unit.test.ts

# 新增主链路（A 实施后存在，规划期未创建）
pnpm exec vitest run tests/integration/core/usage-calibration.integration.test.ts

# 持久化、隔离、传输与原请求合同
pnpm exec vitest run \
  packages/ohbaby-agent/src/core/message/database-store.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-runtime/token-usage-roundtrip.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-runtime/auxiliary-token-usage-isolation.integration.test.ts \
  tests/integration/core/context-subagent-scope.integration.test.ts \
  tests/integration/core/context-improve-4-1.integration.test.ts \
  tests/integration/core/lifecycle-tool-scheduler.integration.test.ts

# cache、公开包消费者回归
pnpm exec vitest run \
  packages/ohbaby-agent/src/services/interface-providers/prompt-cache-wire.contract.test.ts \
  packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.unit.test.ts \
  packages/ohbaby-sdk/src/prompt-cache-usage.contract.test.ts \
  tests/integration/compiled-model-contract.integration.test.ts

# 各实施批次门（保留 pnpm test 覆盖历史无类型后缀文件）
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm preflight

# B 的封闭改名检查：生产源码预期无匹配；旧历史文档不删
rg -n 'realPromptTokens' packages/ohbaby-agent/src
git diff --check
```

`rg` 无匹配 exit 1 是该项预期，不等于测试失败。记录实际 discovered 文件与用例、exit code、SHA、失败补跑和跳过理由。项目 preflight 不检查 docs Markdown（.prettierignore 忽略 md）；规划文档另用显式 Prettier 和本地链接检查。CLI packaging 超时史不豁免 T11；不得以单独通过的定向测试覆盖整包失败。

## 4.6 真实 E2E 矩阵与成本

继承 improve-3 批准的受限 ZenMux 矩阵，实施前只确认是否仍可用，不扩大能力承诺：

| 协议              | 模型                             | maxTokens / timeout | 每行预算                          |
| ----------------- | -------------------------------- | ------------------- | --------------------------------- |
| openai-responses  | x-ai/grok-4.2-fast-non-reasoning | 512 / 45s           | 文本 1 + 工具往返 2 = 最多 3 HTTP |
| openai-compatible | deepseek/deepseek-v4.1-flash     | 2048 / 60s          | 同上                              |
| anthropic         | qwen/qwen3.8-flash               | 2048 / 60s          | 同上                              |

整次矩阵最多 9 HTTP；SDK 重试关闭，第四次实际 HTTP 发送前拒绝；失败后停止该行新请求。不要求 cache 命中，也不新增长前缀暖缓存或专门校准请求。后续复测单独记录请求数，不无限重跑。模型若不可用或触发原生拒绝边界，报告并确认替代方案，不能暗换模型/协议。

沿用 `ZENMUX_API_KEY`，仅在显式 live 命令中从用户授权的仓库 `.env` 加载，不打印密钥/正文。常规 CI 不依赖它。现有两个 Vitest 配置都不会默认发现 `tests/smoke/*.real.e2e.test.ts`，需 programmatic include：

```sh
OHBABY_REAL_MIGRATION_PROTOCOL= OHBABY_RUN_REAL_RESPONSES_MIGRATION=1 node --env-file=.env --input-type=module <<'JS'
import { startVitest } from 'vitest/node';
const files = ['tests/smoke/responses-migration.real.e2e.test.ts'];
const ctx = await startVitest('test', files, {
  include: files,
  exclude: ['**/node_modules/**', '**/dist/**'],
  watch: false,
});
if (!ctx) {
  process.exitCode = 1;
} else {
  const results = ctx.state.getFiles();
  function leaves(task) {
    return task.type === 'test' ? [task] : (task.tasks ?? []).flatMap(leaves);
  }
  const tests = results.flatMap(leaves);
  const expected = process.env.OHBABY_REAL_MIGRATION_PROTOCOL?.trim() ? 2 : 4;
  if (results.length !== 1 || results.some(file => file.result?.state !== 'pass') ||
      tests.length !== expected || tests.some(test => test.result?.state !== 'pass')) {
    process.exitCode = 1;
  }
  await ctx.close();
}
JS
```

全矩阵命令显式清空协议选择，避免继承终端或 .env 的定向设置。定向补跑将命令开头的空值改为 `OHBABY_REAL_MIGRATION_PROTOCOL=anthropic`（或表中另两种协议），仍执行原文件和原断言。全矩阵应发现凭据检查加 3 个模型用例；定向为凭据检查加 1 个模型用例，所有叶子测试必须实际 pass。没有实际执行模型用例不能计作通过。

T12 必须收集：各响应 final usage、本步原始 sentHeuristic、实际校准入参、Run 小计、可承载 metadata 的相等/唯一性和工具实际执行次数。终态 usage 缺失即该行用量验收未通过，即使文本正确。允许在本次已有请求间被动观察，不增加 LLM 调用，不修改 production 方法签名。

本轮 live 没有精度目标；不能因测试 TokenCounter 与真实 token 不同而调整 estimator。Qwen 原偶发未定因保留记录；三次分别成功不写为同一次矩阵全绿。ZenMux 通过不等于官方直连或原生 continuation 可用。

## 4.7 审查、发布门与证据归属

| 门       | 标准                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 规划审查 | 主代理自检 + 三路子代理审查完成，实质问题修订后复核；用户批准才实施                   |
| 每批提交 | 本批 T 项及 §4.5 门通过，子代理 diff 审查，无范围外生产变更                           |
| 技术验收 | T1–T12 有完整分项证据，最终 preflight 和真实矩阵无未解释失败；05 如实记差异和残余限制 |
| 合入     | 独立验收后用户审核，只合本地集成分支；不自动合 main、不 push                          |

实施前审查不写 05；自检报告不另入库。实施后的 05 记录实际命令、SHA、时间、exit code、已复用/新增测试、live 请求数和失败历史，不修改冻结 02 的行号/进度。

对抗性审查优先攻击：A/B 请求错配；把累计当单步；把未知当已知零；text/tool 双写；伪造三协议/SQLite/精度证据；引入新的筛选或作用域策略。防御是上述差异 fixture 和边界断言；残余是未观测失败尝试、模型服务波动和冻结估算误差，不能被测试通过掩盖。
