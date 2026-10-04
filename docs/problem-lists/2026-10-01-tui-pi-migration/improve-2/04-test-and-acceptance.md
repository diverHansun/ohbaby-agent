# improve-2：测试与验收

本文件规定未来实施的验证，不是通过记录。遵循 [docs-test](../../../../docs-test/README.md) 与 [CI 策略](../../../../docs-test/ci-strategy.md)。前端可观察验收见 [frontend/08](frontend/08-test-and-acceptance.md)。

## 4.1 分层与落点

局部纯编辑/格式化用 `*.unit.test.ts`；组件交互和宿主输入用相邻 `*.contract.test.tsx`，现有有价值用例保留。实际串联 App、recovery、store、SDK 的新用例放 `tests/integration/cli/*.integration.test.tsx`，只 fake 外部网络/模型和时间，不把核心流程全部 mock 掉。

沿用 Vitest、Ink、已有 FakeTTY。真机采用 macOS Ghostty，记录版本、字体、窗口行列、tmux/SSH 条件；无条件执行时明确标记未验收。无需搭 Web/Storybook 或新增全局测试平台。

## 4.2 风险用例与 Stage 对应

| ID | 输入/操作 | 可观察通过条件 | 层 / Stage |
| --- | --- | --- | --- |
| I2-T01 | 对照 improve-1 实际 commit、05 与布局契约 | 无上游能力假设；长输入/审批/展开 Tasks 的预算和内容可达性有证据 | 基线 / 0 |
| I2-T02 | 中文、😀、👨‍👩‍👧‍👦、👍🏽、🇨🇳、é 的移动/删除/插入/合行 | 不拆字素、不产生孤立代理项，光标边界始终合法 | unit / 1 |
| I2-T03 | 一次/分片粘贴；显式切在 CR\|LF、人物\|ZWJ\|人物、👍\|🏽、e\|组合音标；stdin 字节/粘贴标记分片 | 允许既有 CRLF→LF 和发送 trim，其余文本一致，无意外提交；UTF-8 解码在真实输入边界测，不向 reducer 塞半字节 | unit＋contract / 1 |
| I2-T04 | 超长行/多行、恰好满行、剩 1 列宽字素、tab、软换行边界、空末行、有效宽度 0/1；120×40 → 60×20 → 80×24 | 验证实际 Ink 物理行与光标列，不仅投影结果；全文可达、原文不变、退化有界、无二次换行溢出 | contract＋真机 / 1 |
| I2-T05 | 普通/候选 PgUp、↑/↓、Tab、Shift+Enter；Alt+↑ 队列、队列普通箭头、Ctrl+↑/↓ Steer | 仍对应既有动作；同键一次只产生当前模式动作 | contract / 1 |
| I2-T06 | A 草稿含中段光标 → B 输入 → A；审批打开/关闭 | A/B 原文与光标各自恢复，无旧响应覆盖新草稿 | contract / 2a |
| I2-T07 | 首发等待 getCurrentModel，切会话，再释放 promise | 未转交快照在原归属可取回，不发到新会话；已转交只查原 receipt | integration / 2a |
| I2-T08 | getCurrentModel 悬挂时连续 first/second；QUEUE_FULL、接管前拒绝；普通回执未知；输入新草稿 | null → 首发 receipt.sessionId 正常绑定不取消 second，同一新会话按序发送；明确拒收文本可取回且新稿不被覆盖；普通 unknown 只查 receipt，retained 才重放 | integration / 2a |
| I2-T09 | 队列 acquire/renew/edit/release 分别延迟、失败、切会话 | 旧 lease 结果不污染当前界面；取消恢复原草稿与光标；失效文本可保留 | integration / 2b |
| I2-T10 | retained 200 行重发已接收但响应丢失；浏览全文再重试 | 只读导航可走到全文且不续租；同 operationId＋首次文本恢复原回执，不多发 | integration＋contract / 2b |
| I2-T11 | 审批 allow/always/deny、仅 allow、空 choices、未知 choice | 文案与真实范围对应；无 deny 的 Esc 不调用 respond；默认选择兼容 | unit＋contract / 3 |
| I2-T12 | 长 description、多行 scope、单个 label 超一屏、多 choices、窄屏、翻页后 Esc；80×12 全 App 同时含 Tasks/辅助状态 | 全部内容可达；选中项标识/键提示可见；长选项全文进入同一正文序列；PgUp 不补历史、不改草稿；翻页后 Esc 后果不变；整 App 行数与 03 预算相符 | contract＋真机 / 3 |
| I2-T13 | 审批未 ready/无 context/重复 Enter/失败/过期/同 ID 新 epoch | 不提前/重复提交；旧错误不污染新请求；PERMISSION_NOT_PENDING resync；Ctrl+C 不误授权 | contract＋integration / 3 |
| I2-T14 | 0/1/5/6/多项 Tasks、6 个 in_progress、20 项×80×24、长中文续行、visible=false 的现存/空数据 | 完成计数基于全列表；可见进行中项可辨；隐藏数量真实；20 项全文可达且不溢出；原顺序不变，续行对齐；运行默认展开/手动收起保持；停止隐藏但数据保留可回看 | unit＋contract / 4 |
| I2-T15 | 长历史＋流式＋长草稿＋Tasks＋审批往返，正常结束/确认 interrupt/失败终止/停止失败，再切会话及 Goal 下一 run | Ghostty 上滚/复制可用，双行底栏无回归；无变化时没有新增持续 stdout；确认停止才隐藏，审批往返不重设偏好，子代理终态不误关父 Tasks，unknown 不假终态，下一 run 默认展开 | FakeTTY＋真机 / 4 |
| I2-T16 | 深浅背景/低色彩/关闭动画，退出重入；Windows 原路径基础回归 | 无色仍识别焦点/错误；终端模式恢复；无新增双宿主/私有 API 依赖 | contract＋真机 / 4 |

## 4.3 可执行入口

现有最小入口（实施时随实际新增文件补精确路径，不把不存在的新文件当成已通过）：

```sh
pnpm exec vitest run packages/ohbaby-cli/src/tui/components/prompt/editor-reducer.unit.test.ts packages/ohbaby-cli/src/tui/dialogs/permission-dialog.unit.test.tsx packages/ohbaby-cli/src/tui/components/todo-panel.unit.test.tsx
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/session-recovery.unit.test.ts packages/ohbaby-cli/src/tui/use-permission-sync.unit.test.tsx
pnpm test:integration
```

保留与改动相关的既有合约；按项目 CI 时点运行 format/lint/typecheck/test/preflight/build，不重复跑相同检查来增加数量。新集成文件先单独运行，再走阶段规定集合。常规 CI 不调用真实付费模型、不执行有副作用的工具命令来模拟审批。

## 4.4 真机步骤与证据

在可控 fixture 中准备有已完成长历史的会话 A/B、延迟提交、超长审批和多项 Tasks。分别在 120×40、80×24、60×20 输入上述字素和中文 IME，粘贴 200 行及 2 万字符单行，移动到开头/中部/结尾，切会话再回来；记录草稿相同、光标所在字素和可见窗口。

审批翻到正文末页后拒绝，确认回到原草稿；另一用例允许后返回同一 run，前轮 working phrase 不被重选。运行中/审批中/结束后上滚阅读并复制一段历史，验证普通更新不持续拉回；在 80×12 用前轮短/长帧基准补退化检查。低于正常支持尺寸只要求有界、可恢复，不能触发被隐藏的授权动作。

记录操作、尺寸、实际结果、截图/控制序列位置。截图不能证明提交只发生一次，控制序列不能证明 IME 体验；两类证据各自使用。

## 4.5 发布门与对抗性审查

必须：I2-P01/P03/P05 的针对性反馈环、队列回执/租约回归、前轮布局与原生回滚回归、真实 Ghostty 交互验收。未完成项在 05 写明，不标整体通过。

重点反问：切会话后谁持有原输入？旧响应还能清掉什么？未知回执重试是否换了文本/ID？Esc 无拒绝项时究竟提交了什么？长内容是否只是隐藏了却再也读不到？防御分别是原归属、代次、原操作重放、显式 choice 映射和可达窗口；残余风险是终端字体/宽度差异及上游未交付布局，不用单元测试掩盖。

## 4.6 Tasks 生命周期新增反馈环

I2-T14/T15 补充：同 run 收起后收到 todo.updated 仍收起；所有 Todo completed 但最终回复尚在流式时保持可见；一次 Esc 仅 armed、停止请求失败不隐藏；成功中断保留原 Todo 状态并隐藏；停止后 Ctrl+T 可看现存数据，清空后不能“复活”；Goal 后端 visible=true 但当前 run 已确认终态时默认隐藏，下一 run 再展开；重连短暂 idle 不作为已停止证据。20 项×80×24 的阅读/高度检查仍保留，不能因为停止后会隐藏就删除。

复用 `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` 已有“keeps completed todos visible through the run and hides them at run end”“recovers the last todo write hidden and reveals unfinished work on the next run”作为后端事实基线；本轮改变 TUI 默认展开与手动回看，应更新 App 既有紧凑默认测试，不能将预期变化算作后端协议缺陷。
