# Web Composer 密度优化：实施与验收记录

> 状态：**实施完成，待用户审查**（2026-09-18）。
>
> 分支：`codex/temp-web-composer-density`
>
> 本记录只描述已落地的改动和验证证据；最终是否合并由用户审查决定。

## 1. 已实施内容

- 主发送槽、运行中停止槽和 queued edit 保存槽都改为 32px 圆形图标按钮，去除可见的 Send、Stop、Save 文案；原有 `aria-label` 和 title 保留。
- queued edit 点击纸飞机调用 `editQueuedPrompt`，沿用原 `promptId`/lease，不走新 prompt 提交；成功后退出编辑，失败保留草稿与错误。
- textarea 使用独立的 [composerTextarea.ts](../../../../apps/ohbaby-web/src/ui/composerTextarea.ts) DOM 高度函数：空稿约一行，最多 7 个视觉行，超出后 textarea 自身滚动并阻止滚动冒泡。
- 推理控件与圆形主按钮继续位于同一输入行，桌面间距为 12px，窄屏（`<=420px`）为 6px；圆钮收窄后不会挤压或遮挡 textarea。
- 顶栏连接状态和工具名去掉内层胶囊；running/connecting/reconnecting 保留轻微 pulse，idle/resyncing/disconnected 静止，并尊重 reduced-motion。
- 权限弹窗和 overlay 的普通 `.ohb-button-primary` 未被圆形按钮选择器连带修改。
- 未增加“已保存”提示；队列列表/编辑态退出是保存成功的可见反馈。

## 2. 自动化验证

### 2.1 通过的测试

```text
vitest：7 files / 288 tests passed
lint：passed
typecheck：passed
ohbaby-web production build：passed
compiled web assets copy：passed
```

覆盖重点：主按钮图标与互斥状态、queued edit 真点击保存且不新建 prompt、textarea 高度封顶、状态和工具标题 CSS、queued prompt 原 ID/条目数保持不变、TUI contract 回归。

真实后端队列集成用例也通过：编辑前后原 `promptId`、文本和队列条目数断言成立，之后由调度器继续执行编辑后的文本。调度器已到该条目时，允许状态很快从 queued 进入 starting/running。

### 2.2 编译版 Web E2E

`scripts/run-compiled-web-e2e.mjs` 通过，证据如下：

- UI：主工具调用、跟进消息、刷新后历史记录、标题脱敏和会话稳定性全部通过。
- 后端：3 次 agent-step 请求、prompt cache key 稳定、工具结果消费、标题请求均通过。
- 清理：daemon 已停止、PID 已释放、端口已释放；诊断日志包含启动/迁移/停止事件且未泄露 fixture 内容。

浏览器视觉/交互检查还覆盖了默认视口以及 375px、320px 宽度：

- 发送按钮为 32×32 圆形且无可见文字；推理控件贴在其左侧，间距分别为 12px/6px。
- 窄屏无横向溢出；长文本 textarea 封顶约 168px（24×7），`overflow-y:auto`、`overscroll-behavior:contain`。
- 工具外层卡片仍保留，工具名不再有内层背景/边框；顶栏 idle 为纯文字。

## 3. 审查结果

实施前后分别由子代理审查文档一致性、实施可靠性、验收与测试标准。最终结论均为无阻塞问题；可靠性审查特别确认 `commitEdit` 会触发调度，因此文档没有把保存后的最终状态永久写死为 queued。

## 4. 剩余边界

- 当前编译版 E2E fixture 的模型不暴露可识别的 reasoning 能力，因此浏览器现场只观察到 `unknown` 档位；identified/detecting/无能力分支由 App.unit、CSS 规则和现有模型选择测试覆盖，未伪称已在该 fixture 中逐一观察。
- 本轮未引入截图像素回归；圆形尺寸、间距、最大高度和 overflow 使用 DOM/CSS 断言及浏览器 computed geometry 验证。
- 本轮没有把 queued edit reject、Stop 按钮真实点击 abort、PageUp/PageDown 与触控板滚动边界、720px 视口及全部 reasoning 能力档位写成“浏览器已通过”；这些仍由 04 的发布门列为后续人工验收项。

## 5. 提交批次

1. `01a8f852 docs(web): define composer density implementation`
2. `2ff43560 feat(web): apply composer density layout`
3. `596565d5 test(web): pin queued edit identity`

当前分支尚未合并或推送，等待用户审查。
