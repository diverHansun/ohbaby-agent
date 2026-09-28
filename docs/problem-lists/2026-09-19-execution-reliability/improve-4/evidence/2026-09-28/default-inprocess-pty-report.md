# 默认 in-process PTY 验收

2026-09-28 11:25–11:26 UTC，在最终全量测试生成的 compiled CLI 上执行；没有再次 build，也没有修改生产代码。控制器及两次真实 PTY 均退出 0，`default-inprocess-pty.json` 中 `failures` 为空。

执行命令：

```sh
node scripts/run-improve4-inprocess-pty-e2e.mjs
node scripts/run-improve4-inprocess-pty-e2e.mjs --launch <manifest>
node scripts/run-improve4-inprocess-pty-e2e.mjs --launch <manifest> --continue
```

`--launch` 仅是验收包装器；它实际启动 `node packages/ohbaby-cli/dist/bin.js`（第一次无参数，第二次只有 `--continue`），没有 `serve` 或 remote 参数。真实模型边界采用本地 scripted SSE provider，SQLite 写入全部由实际产品路径完成。

| 场景 | 证据与结果 |
| --- | --- |
| 默认终端不启动或 attach serve | 现场已有 serve，产品显示 coexistence notice。两次 TUI PID 59151/60421 分别拥有自己执行的 prompt/run；无子进程、无监听 socket，全局 daemon-state 文件元数据前后不变。已有 serve 未被修改或关闭。 |
| Steer 保持当前 run | A_HOLD 已运行，B 和 S 排队；Ctrl+Down/Ctrl+S 将 S 变为 steered。A 的 rootRunId 保持不变，原 provider response 仍打开，没有新增模型 request。随后主动 Stop 前未发生 abort。 |
| Ctrl+C Stop 允许普通 B 推进 | A 持久状态变 interrupted，provider response 关闭，B 自动且仅一次执行成功；TUI 留在同会话。未消费的 Steer 显示规定的 Stop 灰字提示。 |
| 明确退出与重开 | EXIT_HOLD 运行，R 排队；输入 `/exit` 后 PID 59151 退出 0，EXIT_HOLD interrupted，R retained。`--continue` 新 PID 重开同 SQLite/session，R 仍 retained，promptId/userMessageId 不变，也没有模型 request。 |
| retained 手动 Send 与草稿 | 输入草稿，再 Alt+Up/Enter 编辑 R，改为 RETAIN_SENT 并 Enter。只有该条执行，旧 identity 保持；历史最终重绘后 `I4 LOCAL kept draft` 仍存在。 |
| 旧 error footer / stale control 复测 | RETAIN_SENT 成功后最终 footer 为正常 auto/default，没有旧 error；历史 interrupted 行仍准确保留。随后 idle Ctrl+C 直接退出 0，没有再次 Stop 旧 run。 |

模型 request 精确序列：`I4_LOCAL_A_HOLD`、`I4_LOCAL_B`、`I4_LOCAL_EXIT_HOLD`、`I4_LOCAL_RETAIN_SENT`，各 1 次。Steer S 未触发独立执行；R 在手动 Send 前没有执行。此处验证 Steer 接受时同 run 且不 abort，未宣称验证后续模型回合消费，因为本场景故意在该边界前 Stop。

证据文件：

- `default-inprocess-pty.json`：实际 SQLite、provider、process/port 和退出断言。
- `default-inprocess-pty-actions.json`：真实 PTY 输入动作与 ANSI 输出。部分长输出按工具预算截断，已明确保留截断标记；关键最终帧单独保存。
- `default-inprocess-pty-final-frame.txt`：从发送成功后的实际 PTY 最后一次完整刷新提取，包含草稿和正常 footer，不是静态 fixture 渲染。

清理：两次 TUI PID 已验证不存在，provider/controller 已停止；fixture auth/env manifest 未入库，保存副本只含脱敏事件事实。无本轮残留进程、监听服务或浏览器页。已有 serve 保持不变。本轮没有读取 `.env`，没有更改 system prompt、cache key 或 context 拼接，也没有删除 Steer 成功提示。
