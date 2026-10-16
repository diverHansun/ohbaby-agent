# Compact 真实 token 数据流验收（2026-10-16）

原 Web 会话显示的 **42,257 → 9,960 tokens** 是完整请求上下文的估算值。读取该次摘要的数据库元数据，并在压缩后的同一会话发起真实请求，供应商返回的输入 usage 为 **42,270 → 9,772 tokens，减少 76.9%**。因此后续请求确实变小，UI 的变化有后端数据支撑。

压缩前后是相邻的两次请求，后一次询问发布代号，并非逐字相同的提示词。下面的独立矩阵使用相同问题进行前后对照。原会话证据见 [original-web-session.json](evidence/2026-10-16-token-flow/original-web-session.json)。

## 数字从哪里来

1. `core/context/context-manager.ts` 的 `measureUsage` 对准备发送的完整请求估算 token，再乘当前会话的校准系数。`token-estimation.ts` 覆盖消息、系统提示词、工具定义和原生模型状态。这里没有调用供应商 tokenizer，所以 UI 保留 `estimated` 标记。
2. 压缩器用真实模型生成摘要，验证压缩后的请求估算量小于压缩前，随后通过 `messageManager.commitCompaction` 原子保存摘要并标记旧消息部分为 `time.compacted`。原记录仍留在历史数据库中。
3. 后续上下文投影排除已压缩的旧内容；`serializer.ts` 把摘要包在 `<context_summary>` 中发送。读取持久化摘要上的 `usageBeforeTokens / usageAfterTokens`，`adapters/ui-state/persistent-store.ts` 才生成会话里的压缩提示。
4. 独立的 HTTP 观察器在真实 fetch 边界检查发出的请求，并从 SSE 响应副本提取 usage。它不改写请求或响应。测试把这些原始数值与应用归一化 usage 逐项核对。

Chat Completions 使用 `prompt_tokens`，Responses 使用 `input_tokens`。Anthropic 使用 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，避免把缓存命中误当成上下文减少。原 Web 会话压缩后 9,772 个输入 token 中，8,832 为缓存读取、940 为未缓存输入。

## 真实模型矩阵

覆盖 [模型清单](../../../tests/models-4-tests.md) 中的全部 15 个模型与接口组合。下表“实际输入”来自供应商响应 usage；“UI 估算”来自 compact 后端结果。所有行均通过主会话压缩、后续请求与数据库重开验证。

| 模型 / 供应商 | 接口 | 实际输入：压缩前 → 后 | 重开后 | 减少 | UI 估算：前 → 后 |
| --- | --- | ---: | ---: | ---: | ---: |
| aliyun-qwen | anthropic | 43,756 → 9,841 | 10,012 | 77.5% | 44,187 → 10,060 |
| aliyun-qwen | openai-compatible | 43,762 → 10,121 | 10,292 | 76.9% | 44,192 → 10,374 |
| deepseek-flash | anthropic | 41,661 → 9,574 | 9,717 | 77.0% | 42,620 → 9,778 |
| deepseek-flash | openai-compatible | 41,663 → 9,619 | 9,763 | 76.9% | 42,622 → 9,789 |
| deepseek-flash | openai-responses | 41,661 → 9,508 | 9,651 | 77.2% | 42,620 → 9,693 |
| deepseek-pro | anthropic | 41,672 → 9,485 | 9,629 | 77.2% | 42,628 → 9,681 |
| deepseek-pro | openai-compatible | 41,672 → 9,450 | 9,594 | 77.3% | 42,628 → 9,618 |
| deepseek-pro | openai-responses | 41,674 → 9,481 | 9,626 | 77.2% | 42,630 → 9,720 |
| zenmux-deepseek | anthropic | 41,661 → 9,637 | 9,780 | 76.9% | 42,620 → 9,837 |
| zenmux-deepseek | openai-compatible | 41,665 → 9,595 | 9,740 | 77.0% | 42,623 → 9,786 |
| zenmux-deepseek | openai-responses | 41,689 → 9,607 | 9,752 | 77.0% | 42,641 → 9,782 |
| zenmux-luna | openai-compatible | 38,296 → 7,940 | 8,085 | 79.3% | 40,094 → 9,132 |
| zenmux-luna | openai-responses | 38,300 → 7,925 | 8,072 | 79.3% | 40,096 → 9,115 |
| zenmux-sonnet | anthropic | 62,869 → 14,790 | 14,995 | 76.5% | 58,529 → 13,463 |
| zhipu-glm | openai-compatible | 40,571 → 9,525 | 9,666 | 76.5% | 41,867 → 9,771 |


证据见 [matrix.json](evidence/2026-10-16-token-flow/matrix.json)：保留三个阶段的请求摘要哈希、字节数、原始 usage、归一化 usage、测试标记及持久化统计。API key、授权头、请求正文和模型生成的摘要全文均未写入证据文件。

## 怎样证明旧内容没有继续发送

每个 profile 使用独立临时数据库及工作目录，经生产 `createPersistentUiBackendClient.submitPromptAndWait` 入口执行。系统提示词和工具定义使用生产实现，服务端在进程内运行，HTTP 请求发往真实模型供应商。

- 首轮提供 900 行重复的合成观察记录及发布代号 AMBER-731；压缩前再问一次发布代号。
- 观察器确认压缩前真实请求包含全部 900 行。compact 完成后，数据库出现摘要和已压缩标记。
- 压缩后用相同问题请求模型，再关闭并重开数据库，第三次提出相同问题。
- 后两次请求均包含摘要及发布代号，原来的完整 900 行均未出现；输入消息字节量低于压缩前的 50%，供应商实际输入 token 低于 70%。系统提示词及工具定义哈希保持一致。
- 三个对照请求均返回 HTTP 200，原始 usage 与应用归一化值相等。重开后模型仍答出 AMBER-731。

输入字节量统计的是协议内的 messages/input 字段，并非完整 HTTP 包；不同接口把 system/tools 放在不同位置，因此字节数只在同一 profile 的前后比较。用量包含完整请求输入，因此仍有约 8k–15k token 的系统、工具及保留上下文。

## 测试发现与修复

Zenmux DeepSeek Responses 首次请求遇到 `reasoning_text` 被 `response.content_part.added/done` 包裹的合法事件序列。现有解析器只允许 message 内容部分，抛出 `content part requires a message item`，该组当时未能开始压缩测试。

修复 `openai-responses-stream.ts`：接受 reasoning item 的文本内容部分，同时保留索引顺序、文本一致性、重复事件和结束事件校验。新增七种回归用例；修复前合法序列用例失败，修复后 Responses 单元与集成测试 233 个通过。该真实模型组合复测通过，纳入上表。

另外，后台自动标题请求出现两项异常：智谱 HTTP 400；Luna Responses HTTP 200 后响应流取消，符合现有五秒标题超时的表现，但未确认具体原因。它们走已有的独立标题路径，主会话压缩及后续回答均成功。本次没有修改标题逻辑，不能据此宣称所有辅助 HTTP 请求均成功。

## UI 验收

真实浏览器已验证：点击 Compact session 后面板收起；会话显示 Compacting 和竖直压缩动画；可重新打开并关闭面板，进行中按钮禁用；切换另一会话不串状态；完成后 spinner 消失并保留 token 提示；刷新后提示仍在且不重复。用户已确认样式可接受，本次保持样式。

## 复现与范围

先在根目录 `.env` 配置模型清单中的环境变量，再显式执行某个 profile：

```sh
node scripts/run-real-compact-tokens.mjs --run --profile=zenmux-deepseek-openai-compatible
pnpm exec tsc -p tests/smoke/compact-token-flow.tsconfig.json
```

其余 profile ID 见上表对应的 [profiles 定义](../../../tests/smoke/compact-token-profiles.ts)。每个模型 profile 应在独立进程运行，最多允许 12 次 HTTP 请求；默认执行脚本不会调用付费模型。详细运行证据输出到忽略目录 `.ohbaby/test-evidence/compact-token-flow`。测试固定配置 128,000 上下文和 4,096 输出上限，不验证供应商标称窗口大小。

这次矩阵验证合成文本的手动 compact 及恢复，不涵盖所有工具、多模态和自动压缩场景，也不是摘要语义质量的通用评测。压缩本身需要模型读取原上下文，节省的是后续输入量，不会退回历史 token 费用；估算误差和供应商缓存计价还会影响金额。

## 最终检查

提交前全量测试：555 个文件通过、6 个跳过；6,516 个用例通过、17 个跳过。随后补上的两种切换会话失败隔离用例，与观察器及 profile 测试一起运行，35 个通过。收尾逻辑调整后，Zenmux DeepSeek Responses 真实流程再次通过。

生产构建、全仓 typecheck、lint 及变更文件格式检查通过。lint 有仓库已有的 122 条 warning，没有 error。新增 smoke 测试另用专门 tsconfig 检查；这些文件不在根目录默认 typecheck 范围内。独立审查未发现阻碍合并的问题，建议补齐的收尾处理及会话切换用例已完成。
