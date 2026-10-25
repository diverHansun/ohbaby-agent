# improve-2 最新提交复审

> 2026-10-24。按用户“查看最新提交”重新验收。基准为 `03ef136f`：该提交更新文档，最近的产品代码提交为 `376896e0`。本文同时记录基准缺陷与本次未提交的小修；不覆盖前一轮 [37e9b132 审查](06-independent-review-37e9b132.md) 的历史结论。

> 2026-10-25 后续：本文 §5 的“新草稿残留旧首发气泡”已在 improve-4 合并前修复，补齐晚回执、自动迁移回归及真实浏览器验证，见 [合并前回归修复](../improve-4/05-implementation-acceptance.md#合并前回归修复2026-10-25)。下文保留当时的检查结果。

**结论：主体功能已完成，最新提交仍有三个运行时问题；本次已做局部修复并验证。还有一个真实页面复现的 UI 残留，以及 B16 的真实审批/Stop 联动验收缺口，暂不能宣布 B1–B17 全部收尾。** 没有调整架构、CSS 或服务端，也没有提交代码。

## 1. 最新提交的复测结果

| 项目 | `376896e0` / `03ef136f` 的结果 |
|---|---|
| 原 R1：选项目失败后，项目选择器与发送目录不一致 | 普通失败已修；选择器、连接、首发均回默认目录 |
| 原 R2：延迟 `SESSION_MOVED` 抢回用户后来打开的会话 | 已修；仍在 s2(`/b`)，旧提交被拒绝，没有重发 |
| 原 R3 / B15：同目录 New chat 被旧首发晚回执绑定 | **仍失败**；真实 runtime 返回 `created-1` 并选中了它；现有 App 单测只挡 UI 的 `selectSession`，漏了底层 `acceptBinding` |
| 原 R4 / B16：运行中迁移切断原连接 | 集成复测通过：保留 A 的 client/SSE 并提示；运行结束并刷新 control 后，下一轮转 B |
| 同值并发选择：第一次选 B 挂起失败，第二次选 B 成功 | **仍失败，P1**；选择器显示 No project，连接和实际首发却在 `/b` |
| 归档晚响应：归档 s1 等待时切到 s2 | **仍失败，P2**；归档成功后强制跳回默认草稿，覆盖 s2 |

上述三个未修问题均由主审在当前工作树写出失败断言后再修改，不只依靠代码推断。Standards 与 Spec 两路独立复核的结论一致。

## 2. 本次局部修复

产品代码只动三个文件，合计 **29 行新增、12 行删除**：

- `runtime/index.ts`：草稿失败回滚、归档完成后的跳转使用已有 selection generation；旧操作不能覆盖更新的选择。
- `runtime/instance-layer.ts`：删除“同目录、未绑定会话就复用 client”的分支。显式新建草稿使用新 client ID，旧 client 关闭后不再把晚回执绑定到当前 store。
- `api/daemon/client.ts` 与 `runtime/index.ts`：处理浏览器持久化的未知结果记录。新 client 可能继承旧请求的记录；旧请求结束后，只同步清理同目录且已有明确结果的那一条。真正未知的结果继续保留，禁止盲目重发。沿用原有 ledger 和选择代次，没有新增全局事件系统。

新增 `runtime/session-runtime.selection.integration.test.ts`，五条回归覆盖：

1. 同值连续选择的前一次失败不能回滚后一次成功选择。
2. 归档晚响应不能抢走新打开的会话。
3. 首发晚成功：New chat 保持未绑定，新草稿能创建另一会话。
4. 首发明确拒绝：清理继承记录，新草稿能发送。
5. 首发结果未知：保留记录，新草稿仍被安全阻止重发。

后三条启用 `localStorage`，使用真实 runtime、client、store，只在 HTTP/SSE 边界使用已有 fake daemon。补存储场景前确实复现了“选择保住但新草稿仍被 unknown 挡住”的问题，修复后独立复核也通过。

## 3. 自动化验证

| 检查 | 结果与边界 |
|---|---|
| 新回归与原有 session runtime 集成测试 | 22/22 通过 |
| 最终 Web 全量：`pnpm exec vitest run apps/ohbaby-web --maxWorkers=2 --minWorkers=1 --reporter=dot` | **54 文件、683 用例全部通过**，38.35 秒 |
| 最终 `pnpm typecheck` | 全仓通过 |
| ESLint | 基准全仓 0 error / 122 warning；最终补丁涉及文件 0 error / 0 warning |
| Prettier | 四个变更 TS 文件检查通过 |
| 构建 | 基准全仓 `pnpm build` 通过；最终 `pnpm --filter ohbaby-web build` 通过，随后运行 CLI 原有 `copy-web-assets.mjs`，确认两处 `index.html` 一致 |

记录失败，不将重跑抹去：首次 Web 全量与全仓构建并行时，两条 400 microtask 压力测试超过 10 秒；后续四 worker 运行有一条 `goal-resume` 失败，与 05 已记录的抖动一致。最终两 worker 全量通过，未修改超时、断言或这些测试。Vite 仍有单 chunk 大于 500 kB 的已有警告，本轮没有为此拆包。

## 4. 电脑操作与真实 daemon

使用 `scripts/run-compiled-web-e2e.mjs`，隔离 profile、数据库、workspace 和本地脚本化模型。通过电脑操作输入、点击和刷新，不使用 fake UI 代替真实发送。临时本地代理只挂起第一次 `POST /v1/prompts`，使操作顺序可控。

### 4.1 首发晚回执

操作顺序：输入首发 → 代理挂起 → 点击同项目 `New chat in workspace` → 输入不同的新草稿文字 → 放行旧首发。

- 第一轮发现 CLI 仍在使用上一次全仓构建复制的旧 Web 资源 `index-C-2otHvf.js`。该版本实际重现了抢回旧会话、清空新草稿。明确中断这一轮，未把它记成修复后验收通过。
- 将最终 Web 构建复制到 CLI 并重开隔离实例，确认页面实际加载 `index-CJc1P0uO.js` 后重测。
- 修复版 URL 保持无 session 的草稿；新文字 `Keep this new draft after the old reply.` 保留；unknown 提示消失，Send 恢复可用。
- 刷新后仍是草稿，文字和所选项目保留。首发产生的会话仍可从侧栏打开。
- **同时发现下节的旧临时消息气泡残留，不把这一点记成通过。**

### 4.2 正常会话链路

- 打开旧首发生成的会话，展开工具面板：`read fixture.txt`，`outcome: success`，输出 `OHBABY_COMPILED_WEB_FIXTURE_5`。
- 发送包含 `OHBABY_COMPILED_WEB_FOLLOWUP` 的续问，收到预期结果。
- 刷新前后会话 ID 相同，工具后的最终回复、续问和续问回复各一份，没有重复；浏览器 warn/error 日志为空。
- Harness 的 UI、backend、diagnostics、cleanup 全部通过：3 次 agent 请求、稳定 cache key、工具结果被消费；最终 daemon 为 stopped，PID 与端口已释放。

本轮没有改样式；上一轮桌面、900px 抽屉、390px 项目菜单和侧栏分页的有效检查仍见 [06 §4](06-independent-review-37e9b132.md)，不伪称本轮重新走过全部尺寸。

## 5. 剩余问题与完成度

### P2：新草稿残留上一次首发的临时消息

按 4.1 操作，旧首发已明确成功、新草稿仍被选中且可发送，但主区继续显示旧首发的 User message 气泡；欢迎页和项目选择器未出现。刷新页面后恢复正常。没有出现第二次发送或后端数据损坏。

根因：`usePromptSubmission.ts:189–199` 只补充旧 attempt 的会话/消息 ID，未按选择代次移出新草稿；`prompt-projection.ts:59–60` 将所有 `originSessionId=null` 的 attempt 都视为当前无会话草稿，导致 `SessionScreen` 继续显示消息区。现有 App 的晚回执单测只断言不调用 `selectSession`，没有检查气泡、欢迎页和项目选择器。

建议后续只在 `usePromptSubmission` 中用已有选择代次隔离草稿 attempt，补可见行为断言；不要通过重挂整个 Composer 或清空新草稿解决。本轮保留这一 UI 问题，没有把修复扩展到消息投影生命周期。

### B16：真实运行中移动的完整联动仍缺验收

真实 runtime + HTTP/SSE 测试已验证运行中保留旧连接、下一轮转新目录；跨目录归档与导出也有集成覆盖。但没有用真实 daemon 同时走完“运行中由另一入口改项目 → 待审批仍可处理 → Stop 仍作用于原轮 → 下一轮走新目录”。因此仍应标为**部分验证**，不能用单测替代 04 规定的真实 daemon 证据。

整体判断：可以继续做 improve-3，但应保留以上两个收尾项。B15 的选择、输入保留和未知结果保护本轮已验证；草稿显示仍有 P2。搜索、Move to project 菜单属于 improve-3，手机 composer 更多入口属于 improve-4，均不作为本批缺陷。

## 6. 产物与清理

- 代码修改和五条回归保留在工作树，未创建提交。
- 截图保存在 Codex 本地可视化目录：`improve-2-late-receipt-before.jpg`、`improve-2-late-receipt-after.jpg`、`improve-2-latest-e2e.jpg`。
- 临时代理、隔离 daemon、临时回归副本及测试输出在核验后清理；用户原有 5179 服务不改动。
