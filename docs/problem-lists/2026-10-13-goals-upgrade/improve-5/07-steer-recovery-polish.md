# improve-5 收尾：轻量 steer 恢复入口

2026-10-16，基线 `d6f8c128`。用户在 [06 的视觉验收](./06-prompt-and-composer-followup.md) 后指出，展开的输入恢复区仍显冗余、卡片感强，要求由 Pi `google/gemini-4-argon medium` 优化并由主代理视觉检查。

## 保留原因与范围

恢复入口面向用户，不是发给模型的额外 prompt。它来自已关闭轮次的持久化输入：`unconsumed` 尚无请求 attempt，`unconfirmed` 有 attempt 但没有本地成功处理记录。后者无法保证模型完全没看过，不能自动重发。原消息可能已翻页或被压缩，因此保留一个独立、可发现的恢复入口仍有必要。

本轮只调整 Web 呈现：默认折叠为轻量摘要，展开后以原文和手动重发为主，去掉整块卡片外框、独立底色和冗余纵向堆叠；保持与 goal 窄条一致的克制样式。恢复提示和队列在 goal 上方，goal 始终紧贴 prompt 框。

保留重发幂等 ID、折叠不丢失重试身份、跨会话隔离、禁用与进行中反馈、完整原文可查看，以及独立于条目存在的错误提示。重发后由后端投影决定是否隐藏原项，不在前端永久删除。无后端、SDK、存储或依赖变更，不新增通用组件框架。

## 实施与审查

- Pi `google/gemini-4-argon medium` 在既有会话继续本任务，修改 `UnconsumedSteers.tsx`、`composer.css`、移动端覆盖样式和对应交互测试。主代理审查 diff、整合并承担浏览器验收。
- 同状态输入只在摘要显示一次状态；不同状态的多条输入才逐项标注，避免把“尚未处理”和“处理未确认”混在一起。
- 展开后原文与小型 Resend 按钮并排；长正文和列表各自有高度上限和滚动，保持完整文本、键盘焦点、禁用反馈和可访问名称。
- 独立子代理指出完全透明的恢复区会透出其下滚动的聊天历史。主代理用长中文气泡实际复现叠字，然后在整个 `.ohb-steer-recovery` 使用与页面一致的 `#fafafa` 底色，覆盖列表及独立错误提示。没有恢复边框、圆角外壳或阴影。最终复审无剩余问题。
- 只新增同状态去重、混合状态展示的行为断言；既有失败重试、SSE 提前移除、迟到回执、跨会话隔离与折叠不丢幂等身份测试保留。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 全仓 unit | 340 文件，4246 通过、2 跳过 |
| 持久化 steer recovery integration | 23 通过 |
| 最终 Composer + styles 定点复核 | 45 通过，包含在全仓 unit 内 |
| Web build 与 CLI build:package | 通过，CLI 附带 Web 资源同步更新；Vite 保留既有 chunk size 提示 |
| 格式与差异检查 | 4 个代码文件 Prettier 检查、git diff --check 通过 |
| 提交静态检查 | 仓库 pre-commit 的全仓 lint、typecheck 通过；0 errors / 122 既有 warnings |

内置浏览器直接操作真实 daemon/SQLite 的隔离 fixture，模型使用确定性 provider；没有读取用户 API key，也没有运行付费模型请求。1280×850 与 390×844 两个视口验证单条、三条混合状态、764 字多行中文、无 goal、retained queue、默认折叠、键盘展开和重发。手机页面 `scrollWidth=390`；长正文可滚动至末尾，列表可滚动到最后一项。桌面单条展开的 details 为 57px 高。恢复区展开或收起，顺序都保持 **recovery → queued/steer → goal → prompt**。

浏览器重发验收使用受控模型失败：重发准入后入口暂时消失；模型失败、无成功处理记录后原项重新出现。恢复 provider 后再次手动重发，模型成功响应且入口消失。此处验证模型执行失败后的恢复，不把它冒充提交 API 失败；后者及迟到错误继续由既有交互和集成测试覆盖。页面自身控制台无 warning/error。

截图保存在本地视觉产物目录，包括 `steer-recovery-before.jpg`、`steer-recovery-composer.jpg`、`steer-recovery-mobile.jpg` 和多条长文本场景。截图与临时 fixture 不进入产品仓库。验收后已停止临时服务、清理隔离数据目录、关闭临时标签页并恢复浏览器视口。

## 提交与集成

- `6df59a7a`：恢复入口样式、状态去重与交互测试。
- 本验收记录与架构说明单独提交；随后将 improve-5 本地 fast-forward 合入 `codex/goals-upgrade` 与 `main`，不 push。
