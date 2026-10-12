# improve-2 参考项目与取舍

> 2026-10-12 复核。本地参考根目录：`/Users/hansun025/Projects/code-cli/`。本次按 [plan/03](../plan/03-reference-projects.md) 列出的位置小范围核对，只借鉴思路，不整套引入别的输出存储体系。
> ohbaby 的规则由 [00](./00-discussion.md) 和 [02](./02-optimization-plan-and-change-scope.md) 确定。

## 1. 参考范围

| 项目 | 本次核对位置 | 借鉴主题 |
| --- | --- | --- |
| 本地 claude-code | `claude-code/src/utils/toolResultStorage.ts:369`、`:741`、`:940` | 结果首次定型后冻结，重放走已保存的字节一致替换 |
| Kimi | `kimi-code/packages/agent-core-v2/src/agent/toolResultTruncation/toolResultTruncationService.ts:264` | 区分全文／仅保存捕获部分／保存失败，并单独标注媒体 |
| ZCode | `ZCode/apps/zcode-cli/packages/adapters/src/exec/output-collector.ts:51` | 内存内联上限、磁盘捕获上限、尾部保留三者分开 |

本地 claude-code 是非官方重建项目，不能当作官方实现保证。这里只引用已核对的局部存储行为。

## 2. 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
| --- | --- | --- | --- |
| claude-code | 结果一旦“见过”（`seenIds`）就冻结命运，替换正文从缓存字节一致地重放（`replacements`） | 正是“首次入模定型、重放稳定”的机制，保前缀 | 借原则；但 ohbaby 不做它那套“大结果落盘 + 预览替换”的磁盘服务 |
| Kimi | 明确区分“只保留了前 N 字符”“全文已保存”“媒体仍在结果里”，并给下一步读取路径 | 捕获不完整必须如实标注，不假装可恢复 | 借“完整性标注 + 可读路径”；不搬它的字符上限数值与整套截断服务 |
| ZCode | `maxInlineBytes`／`maxPersistedBytes`／`maxTailBytes` 分开，并记 `truncated` 标记 | 内联预览与磁盘捕获不是一回事 | 借“分开计数、记录是否完整”的语义；不引入新的落盘上限配置 |

## 3. 明确不照搬

- **不做聚合批次预算／均分器**。claude-code 的“每条消息聚合预算”是另一种额度，plan 已撤回统一单条 8K／批次 20K，ohbaby 不引入。
- **不新建全工具落盘服务**。三家的磁盘捕获是它们的完整方案；ohbaby 沿用工具自身分页／限长与已存在的结果文件（子代理结果、Read 页）。
- **不改写已发送的历史用于省窗口**。三家都在入口定型，改写旧结果不是它们的常规路径。
- **不用字符串 slice 冒充结构化／媒体处理**。MCP 媒体的 base64 内联在本批只如实标注，不在这里造媒体管线。

## 4. 对 02 的影响

- T1（MCP 错误 metadata 丢失）是 ohbaby 自己的缺口，参考项目不涉及；修法只把已有 metadata 接回投影，不借外项目结构。
- T3（Read 游标）与 T4（捕获完整性标注）借上表的“定型 + 完整标注”原则，落点在 `read-file-page.ts` 与 `tool-adapter.ts`，不新增配置面。
