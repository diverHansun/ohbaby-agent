# 定向证据审查：真实请求、上下文与缓存

结论：**可以作为三组真实后端场景的通过／带限制通过证据交付；两处报告表述已定向复核关闭。** 未发现本组证据证明了新的提取回归；也不能用本组短会话验证推断所有模型、长上下文、压缩流程或全部 wire 语义均通过。

## 已关闭的报告表述问题

1. `real-context/REPORT.md` 首段及 `audit-context.mjs` 报告模板将本组称为使用已编译的 LLM package entry，不准确。runner 直接导入源码 harness，根 tsx loader 使用 tsconfig paths。以相同 loader 执行只读 `import.meta.resolve('ohbaby-llm')`，结果为 `packages/ohbaby-llm/src/index.ts`。本组应称为“真实 source/backend 接线与已迁移 LLM 包源码验证”；独立 `real-process` 组的显式 dist 导入证据可以另列。无需新网络请求。
2. Chat 表中的 cache-write `0` 是缺失字段的归一化默认值，原始 usage 没有 cache-write 字段，`observed.cacheWrite=false`。请标为“未报告（归一化 0）”或加脚注；不能声称供应商明确测得写入为零。该限制不影响 cache-read 命中及其分母。

## 原 exit 1 的离线纠正

- **Responses：合理且证据充分。** 原 runner 漏读 `input_tokens_details.cache_write_tokens`；四条原始 usage 明确保存 7745、61、182、55，分别与生产归一化输出相同。离线修正直接读取原始证据，既没有改生产行为，也没有重复请求获取更好结果。
- **Anthropic：可作为带限制通过，不能改称严格原断言通过。** 原始 wire-prefix 断言确实失败，证据保留该失败。源码 `applyLastBlockCacheControl` 会改变原最后可缓存块，行哈希变化位置也与之相符；provider-neutral 完整消息前缀哈希一致。因未捕获剔除 cache_control 后的 semantic wire hash，无法证明 wire 差异仅来自该字段。报告已明确不声称 wire 字节 append-only，此限制必须保留。
- Luna 的额外失败 skill 调用确实存在；一个成功 read 及后续无新工具调用有证据。应保留“场景未严格做到只尝试一次工具”的限制。

## 独立核验结果

读取三组 `.json`、`.wire.json`，按 context id 对齐 prepared/provider/wire 请求，独立重算后均一致：

| 协议 | 主请求数 | inclusive input 累计 | cache read 累计 | read / inclusive input |
| --- | ---: | ---: | ---: | ---: |
| Chat | 3 | 28441 | 26368 | 92.7112% |
| Responses | 4 | 31594 | 23539 | 74.5047% |
| Anthropic | 3 | 43750 | 14652 | 33.4903% |

分母包含缓存读／写部分，排除 title 请求；cache write 不进入命中分子。Anthropic 的 inclusive input 正确为 uncached input + read + creation，前两次 read=0，只有 followup 实际命中。三组都有正数供应商 cache-read 数据，不能仅由控制字段推断命中。所有保留主请求 HTTP 200、provider exhausted/settled、两轮状态成功，未见 capture/cleanup/permission 错误。

10 个 context-update 均可由记录的 heuristic 和初始 1、alpha 0.5、clamp [0.5,3] 的 EMA 精确复算。窗口比例为 currentTokens / 探测所得完整窗口；1,000,000／1,050,000／1,000,000 是元数据探测值，未做满窗口承载实验。分子是经过校准的最近一次准备上下文估算，不是最新响应写回后的重数，也不是供应商未缓存计费 token。源码证实 composition 使用独立未校准估算，故其总和不必等于校准后的 currentTokens。

Chat／Responses 的 raw input-prefix 摘要和各组 system/tools 摘要稳定；全部 provider-neutral 消息前缀一致，工具 call/result 数量、顺序与配对检查通过。原文未持久化，审查依赖采集时哈希及取样代码，不能离线恢复或语义检查全部内容。

只运行了只读解析／重算和 resolver 查询，没有发新网络请求、运行完整测试、修改源码或重写原始证据。父代理已修正最终 REPORT.md；本报告的可交付结论成立。

## 定向关闭确认

仅复核最终 `real-context/REPORT.md` 的三处修改：首段正确说明 tsx paths 解析到 LLM 源码，并将编译产物证据另列；Chat 写入列改为 `unreported (normalized 0)`；usage 段明确 `observed.cacheWrite=false` 与归一化 0 不代表供应商实测零写入。两项表述问题均已关闭。未重开广泛审查、运行测试或发起新网络请求。现有 Anthropic wire 语义前缀与 Luna 工具场景限制仍应随报告交付。此次仅确认最终报告；原始审计脚本保留历史，重新运行会覆盖手工修正文案。
