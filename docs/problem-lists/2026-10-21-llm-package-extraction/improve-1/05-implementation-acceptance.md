# 5. 实施与验收记录

> 分支：`codex/llm-package-extraction`。基线：`main@73e065e7`。本轮只分批提交，不 merge、push 或发布 npm 包。

## 5.1 实施状态

| 阶段     | 内容                                                       | 提交       | 状态 |
| -------- | ---------------------------------------------------------- | ---------- | ---- |
| 规划复核 | 补齐 server 测试消费者、包装层类型来源、脚本与发布文档清单 | `c3aff07d` | 完成 |
| Stage 1  | 在 agent 内拆开纯客户端、配置日志包装层和 UI 投影          | `08f383c7` | 完成 |
| Stage 2  | 新建 `packages/ohbaby-llm` 并迁移实现、消费者和构建配置    | `e58a0a1a` | 完成 |
| Stage 3  | 打包安装验证、脚本和模块文档                               | `302930cc` | 完成（TUI 真实模型对话待补） |

Stage 1 是迁移前的中间状态。最终 LLM 实现进入 `packages/ohbaby-llm`；agent 的 `core/llm-client/` 仅保留读取配置、接入日志的包装函数和依赖 agent 的测试，不保留第二份实现。

## 5.2 已完成验证

### Stage 1

- S1-1：扫描 21 个非测试实现文件，无越界依赖。
- S1-2：6 组固定缓存键输出，先在旧实现上通过，再在私有编码实现上通过。覆盖普通 ID、子作用域、空格、分隔符、中文和空值。
- S1-3、S1-4：包装层配置默认值、显式路径、诊断日志和推理视图测试通过。相关测试 44 个文件、1037 个用例通过。
- `pnpm run typecheck`、`pnpm run lint` 通过；lint 为 0 error、122 条既有 warning。
- `pnpm run test`：578 个文件通过、6 个跳过；6840 个用例通过、17 个跳过。
- TypeScript compiler API 对比：agent 567 个公开导出名完全一致。
- 子代理完成规格与代码质量复审；Pi 使用指定的 `opencode-go/gemini-4-argon-contributor`、medium 完成只读复核。两者均未发现阻塞问题。

### Stage 2

- S2-1：新包 44 个 TypeScript 文件边界检查通过，依赖只有 `openai`、`@anthropic-ai/sdk`、`zod`。
- S2-2：agent 567、server 40、sdk 260 个导出名与基线完全一致，源码和 dist 两种口径都已对比（Stage 2 结果；5.6 的改动没有改变 agent 导出名）。
- S2-3：agent 旧 providers 目录已移除；客户端目录只保留包装层、入口和两份依赖 agent 的测试。纯配置文件已迁入新包。
- S2-4 至 S2-6：重点测试 27 个文件、710 个用例通过；全量 `pnpm run preflight` 通过，578 个文件通过、6 个跳过，6841 个用例通过、17 个跳过。
- 五包打包安装冒烟、编译产物三种协议的文本和工具调用回归通过。
- 复审发现两项 CLI 测试的独立构建名单漏加新包；已修复，并移走 `ohbaby-llm/dist` 后验证这两项测试，共 4 个用例通过。另补齐两处失败堆栈路径过滤，保留原脱敏和条数限制。
- 子代理定向复核确认上述问题关闭；Pi 已对本批依赖、迁移和公开导出完成静态复核。

### Stage 3 与最终回归

- S3-1、S3-2：五个 0.1.16 tarball 在独立目录安装成功；`ohbaby --version`、`ohbaby --help` 和新包公开入口导入通过。tarball 无 `workspace:`、测试声明或内嵌 `node_modules`，agent 对新包依赖为具体版本。补完 README 后重新打包检查新包。
- S3-3：两个脚本语法检查通过，旧路径扫描只保留标题脚本对 agent 配置包装层的预期引用。模块文档、打包顺序、包 README、未发布说明已同步。
- server 的 goal-execution 与 model-idle E2E：6 个通过、4 个既有跳过。
- 编译产物 Web fixture 手工测试：流式文本、read 工具结果、续聊、标题、刷新恢复通过；后端确认 3 次主请求的缓存键稳定、环境提醒只有一份、工具结果进入后续请求。退出后端口与进程释放，诊断脱敏检查通过。
- 真实 PTY 启动编译后的 TUI，经新包客户端和本地 HTTP fixture 返回 `LLM_PACKAGE_TUI_OK`，退出后 `--continue` 恢复会话成功。
- 真实供应商请求、Web 手工操作和上下文/缓存专项检查见下文；本地 fixture 与真实请求分别记录。
- Stage 3 提交前格式、lint、typecheck 通过；lint 仍为 0 error、122 条既有 warning。后续只有验收文档和证据整理，不重复执行全量测试。

## 5.3 真实供应商验证

用户要求执行真实调用，因此本轮执行了 04 中原列为可选的 S3-4。模型清单来自 `tests/models-4-tests.md`，端点与配置来自现有 `COMPACT_TOKEN_PROFILES`。key 从根目录 `.env` 读入内存；真实请求只包含合成提示和临时测试文件，证据不保存凭据、请求头或完整系统提示。

### 编译产物的 15 条模型/协议路由

显式导入 `packages/ohbaby-llm/dist/index.js`，通过 `createLLMClientFromConfig` 和 `streamResponse` 请求 Zenmux、智谱、阿里云、DeepSeek 官方路由。

- 原配置首轮 **14/15 通过**。
- 智谱 `glm-5.3-flash` 拒绝 `thinking: { type: "disabled" }`，返回 HTTP 400 / code 1210。
- 同端点、模型和客户端另发一次诊断请求，省略该可选控制后成功。共 16 次 HTTP，15 条路由均得到过成功响应；这不等于原配置 15/15 通过，也不证明该路由支持关闭推理。
- 该序列化行为与抽包前一致，本轮没有为绕过供应商拒绝而修改生产配置或放宽仓库测试。

### Web 真实端到端手工测试

启动编译后的 CLI/server/Web，在三个隔离配置下分别使用 Zenmux Chat（DeepSeek）、Responses（Luna）、Anthropic（Sonnet）。每组均通过浏览器输入，请模型读取 `fixture.txt`，下一轮不调用工具复述标记，再刷新检查历史。

三组都成功返回 `REAL_WEB_LLM_EXTRACTION_OK`，工具状态成功，标题生成正常，刷新后两轮内容和会话 ID 保留。Sonnet 的 `/status` 显示 cache hit 66%，上下文约 12.2K / 131.1K；这里的窗口是测试配置指定值，不是模型实际容量探测结果。

补充手工回归：

- `/connect` 将同一隔离会话从 Sonnet 切换到 DeepSeek 的 Anthropic 路由，下一次请求使用新模型；刷新后推理选项为 Off、minimal、low、medium、high、xhigh、max，当前值 medium。
- 短会话执行 `/compact` 正常提示 `Nothing to compact`。加入合成填充文本和一轮短回复后再次压缩，显示 `26,022 -> 7,601 tokens`（本地估算）。压缩后新提问不重复给出标记，仍得到原标记；刷新后压缩记录与回复保留。
- 真实供应商不保证返回可见推理正文，因此另用本地 HTTP fixture 发出合成 `reasoning_content`，手工展开 Thought 检查正文。它验证编译后的解析和 Web 渲染链路，不冒充真实模型推理内容。补充 fixture 首次因启动时 stdin 未保持交互而无法回传验收结果，清理后使用 PTY 重跑；最终退出 0，后端断言、诊断和进程/端口清理均通过。

## 5.4 请求结构、消息顺序、窗口占用和 cache hit

复用 `createFormalCacheSession` 与 `installFormalCacheObserver`，每个协议各跑真实 read 任务和一轮纯对话续聊。该组由根 tsx loader 加载，通过路径映射使用新包**源码**；编译产物由上一节的独立路由测试和 Web 测试覆盖，不能混称这一组也使用 dist。

| 协议               | 主请求数 | 含标题、元数据的 HTTP 总数 | 累计输入 | Cache read |        Cache write | 输入中缓存读取占比 |
| ------------------ | -------: | -------------------------: | -------: | ---------: | -----------------: | -----------------: |
| Chat / DeepSeek    |        3 |                          5 |   28,441 |     26,368 | 未报告，归一化为 0 |             92.71% |
| Responses / Luna   |        4 |                          6 |   31,594 |     23,539 |              8,043 |             74.50% |
| Anthropic / Sonnet |        3 |                          5 |   43,750 |     14,652 |             29,092 |             33.49% |

三种协议都有供应商实际返回的正数 cache-read，用参数存在推断命中的做法没有用于验收。没有为了拿到命中而反复请求。

**请求和消息顺序。** Chat 使用 `messages`，system 在前；Responses 使用 `instructions` 与 `input`；Anthropic 单列 `system`、`tools`，工具结果位于后续 user 内容块。三组的 system/tools 摘要保持一致，历史消息前缀保留，工具 call/result 的 ID、次序和配对通过。Chat 和 Responses 的 wire 输入前缀摘要稳定。Anthropic 会移动最后一个可缓存块的 `cache_control`，原始 wire 前缀不逐字相等；本轮未捕获去掉该字段后的语义摘要，因此只确认模型无关消息历史保留，不宣称 Anthropic wire 字节级前缀完全不变。

**用量归一化。** 主请求的原始 usage 与归一化数值逐项核对一致。Chat/Responses 的输入已含缓存部分；Anthropic 要把未缓存输入、缓存读取、缓存写入相加。Chat 未报告 cache-write，`observed.cacheWrite=false`，不能把归一化 0 说成实测零写入。

**缓存占比。** 分子是累计 cache-read，分母是包含缓存部分的累计输入，均只统计主请求，排除标题请求。cache-write 不进入命中分子。这是 token 占比，不是命中请求数比例。Web 的 66% 来自另一场独立会话，不应与表中 Sonnet 的 33.49% 混用。

**上下文窗口。** 这组探测值分别为 1,000,000、1,050,000、1,000,000；没有进行满窗口承载测试。占用分子是最近一次准备上下文的本地估算，按供应商实际输入反馈校准；不是未缓存计费量，也不是直接显示最后一次 API 输入。10 次 context 更新已按源码公式独立复算，均与后端相等。组成分类仍是未校准估算，因此其加总可能不同于校准后的总量。

例如 Sonnet 续聊的原始估算为 10,527，校准系数约 1.299067，四舍五入得到 13,675，与后端一致；该次供应商实际输入为 14,730。这三个数含义不同。

**证据限制。** 临时 runner 首次退出 1：一处是审计代码漏读 Responses 的 `input_tokens_details.cache_write_tokens`，已用保留的原始 usage 离线纠正；另一处是上述 Anthropic 原始前缀严格断言不成立，保留为限制，没有改称该断言通过。Luna 还多尝试了一次失败的 skill 调用，随后 read 成功，不能称为“严格只尝试一次工具”。这些情况没有通过修改生产代码或放宽仓库测试掩盖。

## 5.5 复审与交付状态

- 子代理按阶段审查规格与代码质量，最终整分支复审通过。关闭了两项独立 CLI 构建名单遗漏和两处文档测试路径错误。
- Pi 使用用户指定的 `opencode-go/gemini-4-argon-contributor`、medium，在同一独立会话中完成三阶段只读复核；完整原文已在实施会话展示。最终结论为可提交，并要求如实保留智谱限制。
- 追加的独立证据审查重算了 10 个主请求的 usage、缓存分母和 context 校准结果。纠正了“源码验证误称 dist”和“未报告 cache-write 误称实测 0”两处报告措辞，未发现新的抽包回归。
- 04 §4.5 的对话、流式、工具、推理显示、模型切换、压缩与标题已有上述手工记录，但真实模型只走了 Web。TUI 只用本地 HTTP fixture 验证过，没有和真实模型对话，因此 04 §4.6「4.5 全部手工确认」尚未完全满足，需补测一次 TUI 真实对话。footer/cache 的数值依据固定输出回归、真实原始 usage 核算和当前界面检查；未另做抽取前后 UI 截图对比。各组范围如上，不把 fixture 当成真实供应商结果。
- 本轮实现完成，验收含上述明确限制，等待用户审查。当前分支保留；没有 merge、push 或发布 npm 包。后续前端重构尚未开始。

测试日志、截图、采集数据和详细诊断报告仅保留在本地，不纳入后续提交。原 `evidence/2026-10-21/` 产物已按用户要求从当前分支移除，历史验收摘要保留。

## 5.6 审查后修正：包类型去除 agent 概念

整分支审查发现，`ohbaby-llm` 虽然没有依赖 agent，类型里却还带着 agent 的概念。这一节记录对应的修正，以及新增的中立取消判断。

- **请求观测改为中立类型。** 包里只保留 `ModelRequestAttempt`，字段是 `requestId`、`attempt`、计时、`usage` 和 `outcome`。`streamResponse` 去掉了 `requestOwner`、`summaryOwner` 和 `onSummaryRequestRecord`，普通请求和摘要请求统一走 `beforeRequestAttempt` 与 `onRequestObservation`。`AgentStepRequestRecord`、`SummaryRequestRecord` 和 `ModelRequestRecord` 迁回 agent 的 `core/message/types.ts`，`runId`、`step`、`compactionId` 等字段由 lifecycle 和摘要客户端在回调里补上。落库字段与之前一致。
- **摘要路径有两处行为变化。** 一是摘要流里现在也会产出 `requestObservation` 帧，摘要循环会忽略这些帧。二是提前关闭生成器时，会真正中断 HTTP 流。记录的 outcome 和错误类型不变。
- **新增中立的取消判断。** 包新增 `isAbortError(error)`，同时识别 OpenAI 和 Anthropic 两家 SDK 的取消错误。原来从 `openai` 转出的 `APIUserAbortError` 只认 OpenAI，现在保留并标记为 deprecated。agent 根入口不新增导出，导出名仍是 567 个。
- **刻意保留。** `LLMRequestPurpose` 的取值会驱动缓存、推理和重试逻辑，属于请求语义，这次不改。`model.json` 的配置类型也留在包里，等确定要对外复用时再迁回 agent。
