# improve-5 收尾：Goal 提示词与缓存前缀

2026-10-16，基线 `6eb3fdf0`。本轮对照四个本地参考项目，优化 Goal 的执行、续跑和完成判断。仅改提示词及验证，不改目标状态机、权限、预算实现或 provider 请求策略。

## 提示词来源与调整

| 文件 | 职责与调整 |
| --- | --- |
| `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md`，Goal mode 段 | 固定 system 规则。完整目标跨轮保留，目标存储优先于冲突的压缩摘要，同时尊重用户后续修正；逐项验收、子代理收尾、Todo 辅助和完成后结束本轮保持一致。 |
| `packages/ohbaby-agent/src/goals/constants.ts`，`GOAL_CONTINUATION_CORE` | 首轮/续跑自审。用当前工作区和工具证据推进必要工作，不能把已有子集当成完整目标；未完成时保持 active，不因任务难、慢或待验证而 blocked。 |
| `packages/ohbaby-agent/src/goals/injection.ts` | 动态 objective、criterion、轮数、时长和显式预算的 user 消息。澄清任务数据需要执行但不能覆盖高优先级指令；接近预算上限不能代替完成证据。保留 XML 单次转义和 token/cache 数字不进入自动提醒的规则。 |
| `packages/ohbaby-agent/src/goals/tools.ts` | 对齐 `CreateGoal` / `UpdateGoal` 描述；可检查的 objective 不强求额外 criterion；同一阻塞原因保持稳定措辞，后端负责累计。执行代码、参数形状和权限未变。 |
| `packages/ohbaby-agent/src/core/system-prompt/prompts/templates.generated.ts` | 从 Markdown 生成的构建产物，通过 `prompt:generate` 更新，不手工编辑。 |

旧文案的 `one coherent slice` 容易暗示人为切小每轮工作，`no useful next action` 可能导致完成后仍寻找额外任务；改为围绕完整目标和必要工作判断。完成需要当前证据覆盖每项要求，验证范围必须覆盖声明范围；计划只有在用户要求的交付物本身是计划时才足够。

连续阻塞仍是 ohbaby 的既有协议：每个真正受阻轮报告一次，后端累计同因 1/3、2/3、3/3。原因比较是 trim/lowercase 后的文本相等，不是语义归类，因此要求原因措辞不随轮次变化。模型仍只能 complete / blocked，用户通过 `/goal resume` 恢复。

## 参考项目与借鉴边界

参考路径均相对 `/Users/hansun025/Projects/code-cli`：

| 项目与真实提示词路径 | 借鉴的意思 |
| --- | --- |
| `codex/codex-rs/ext/goal/templates/goals/continuation.md` | 目标不会因为一轮结束而缩小；逐项证明成果，不能仅凭“没找到剩余工作”判定完成。 |
| `deepseek-harness/packages/goal/goal-round-driver/src/prompt.ts` | 当前文件、工具结果和持久状态优先于旧叙述；每轮推进并验证，剩余工作继续 active。 |
| `kimi-code/packages/agent-core-v2/src/features/goal/goalService.ts` | 正常轮次结束不代表目标终止；大、难、慢、待验证不是阻塞；不要无必要地向用户澄清。 |
| `ZCode/apps/zcode-cli/packages/contracts/src/tools/target.ts` | 不重复已完成的工作；绿测必须覆盖用户要求；用户只要求计划时，计划就是可验收成果。 |

不移植参考项目中由模型自行等待三轮才调用 blocked、模型 resume、token 预算、主动反复轮询子代理、Todo 硬门禁或独立完成 verifier。这些与 ohbaby 的实际执行协议不同。

## 三个接口的缓存边界

固定规则无条件装入 primary system，工具描述也不随当前目标或预算改变。动态提醒由 `goals/service.ts` 从准入快照生成，通过普通输入链路追加为持久化 user 消息；runtime context 只附加一次。旧历史不重写，压缩后从 GoalStore 重建新一轮目标文本。

| 接口 | 保留的请求契约 |
| --- | --- |
| OpenAI Chat Completions | messages / tools 保持顺序和旧前缀；受支持策略下的 `prompt_cache_key` 仍只按 session / contextScope，不加 goalId、预算或轮次。 |
| OpenAI Responses | 固定 system 对应 `instructions`，目标进入 `input`；保留 `store: false` 和 observe-only 策略，不新增 Chat 缓存字段或 `previous_response_id`。 |
| Anthropic | system 独立，目标在 user 历史；保留稳定 system anchor 和官方 automatic cache control，现有显式模式及摘要边界不变。 |

这符合 [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) 与 [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 对可复用前缀的要求。固定提示词升级会改变旧版本前缀，不能复用旧版本对应部分的缓存；同一新版本运行中仍保留稳定前缀。实际命中还受模型门槛、缓存边界、有效期和服务端路由等影响，结构回归不能证明真实命中率。

## 审查与验证

三个子代理分别核对 Codex/DeepSeek、Kimi/ZCode 和注入/缓存代码；独立复审发现“仍有工作时不调用 UpdateGoal”可能覆盖真正阻塞场景，最终三处统一限定为“仍有工作且可以继续推进”。复审确认该冲突关闭，未发现新的具体问题。

按用户指定，通过 Pi `google/gemini-4-argon`、`medium` 审查并做局部改进。采纳：明确部分成果不足以完成；完成后停止新工作；原因逐字复用且不附带轮次；完全受阻且无独立工作时可以结束当前轮；接近预算时不能先 complete 再报告未完成项。监督后撤销其新增的“单轮任务禁止创建 Goal”，避免额外限制用户明确启动；将“单次失败不是阻塞”精确为“不能仅凭单次失败推断阻塞”，保留依据已证实外部条件报告的能力。未改执行逻辑。

最终验证：

- 新的提示词约束测试在旧文案上有 4 项失败，修改后通过。测试保护关键语义，不能证明模型一定遵守。
- 最终定点回归 **21 文件、355 项全部通过**：Goal 全部单元/契约/集成、system prompt 资产与 provider、context manager、序列化、Goal 压缩集成和缓存策略。
- 新增三接口 wire 契约使用真实 goal renderer、system、工具定义和 provider 序列化，验证首次到续跑的预算/计数变化只进入新消息，旧历史与工具/系统前缀不变，调用方数据不被改写。该测试覆盖 provider 边界，与已有真实 context/admission/compact 链路的 `goal-context.integration.test.ts` 配合；没有将手动构造历史的 fixture 误称为全链路缓存测量。
- `prompt:generate` / `prompt:check`、改动 TypeScript 格式检查与 `git diff --check` 通过。提交钩子执行全仓 lint 与 typecheck。

本轮没有调用真实产品模型 API 测量 cache hit，也没有需要浏览器验收的 UI 改动。结构测试能防止提示词/请求拼装回归；模型行为改善仍需真实使用观察。代码、测试与本记录在 improve-5 收尾提交，沿用此前授权，本地 fast-forward 合入 `codex/goals-upgrade` 与 `main`，不 push。
