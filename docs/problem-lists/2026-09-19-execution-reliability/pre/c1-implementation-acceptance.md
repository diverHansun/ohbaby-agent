# C1 文件锁寿命：实施与验收

## 范围与基线

本次从开发分支 `codex/execution-reliability` 的 `68b11ba2` 创建本地临时分支 `codex/pre-c1-file-lock-lifetime`。基线已包含前置 A/B、improve-1 和 improve-1.1；未使用 worktree，不合并、不推送。

按 [C.3 与 C01/C13](c-concurrency-and-resource-protection.md) 实施 C1。此前[约定方案分享页](https://chatgpt.com/s/cx_6ab689e53a6c8191b8eb6a9917882585)已通过浏览器读到正文并核对。该页及仓库方案要求 C1 独立锁层验收、C2/C3 继续组合验收后才合回；本次用户消息另提到 improve-2 后做 C2/C3。本次只落实明确一致的 C1 范围，不修改后续路线；后续开始 improve-2 前仍须核对其 S0 对完整 C 能力的依赖。

## 实现边界

- 删除锁内部的默认 120 秒执行计时器及 `timeoutMs` 选项。scheduler 原有工具期限、取消和真实操作结束后的并发槽处理不变。
- 队列后继连接到真实 operation 的成功或失败，而不是调用方的超时结果。拒绝也转成可继续排队的尾节点；只清理仍属于自己的 Map 尾节点。
- `FileLockOptions.signal` 只取消尚未开始的等待。预先取消或取得锁前取消均不调用 operation；取消等待者的返回不会解除当前持有者或后继的保护。
- 操作开始后，锁返回的 Promise 继续跟随真实操作。外层 scheduler 可先返回超时/取消，但不得因此把真实 operation 误判为完成。迟到失败仍被观察。
- Write/Edit 将原有执行信号传入锁。原有完整读、校验、写入和提交后元数据读取仍在同一保护范围内。

从 SWE 职责划分看，本次去掉了锁与 scheduler 重复计时的控制流；文件锁只接收取消信号，不依赖会话、数据库或 UI，也未新增调度状态机。

## 验证记录

基线定向检查：锁单元、文件工具 scheduler 集成、scheduler 单元共 3 文件、72 项通过。

先运行新增回归再改实现：旧锁出现 4 项失败（两种迟到结束在 120001ms 后提前放锁、忽略等待取消、忽略预先取消）；Write/Edit 传信号前，两项接线回归均失败，原始工具 Promise 在取消后仍留在队列中。修复后再验证，不保留旧测试中“超时就允许下一写入”的错误预期。

| 检查 | 结果与证据边界 |
|---|---|
| `pnpm exec vitest run` | 397 文件通过、6 文件按既有条件跳过；4352 项通过、17 项跳过，退出码 0，约 220 秒。包含 unit/contract/integration、真实 CLI/daemon 及本次新打包的冷安装验证；外部模型条件跳过不冒充通过。全量运行时锁单测为 5 项，之后两项竞态/监听补强及最终 abort 错误规范化由下行定向复验覆盖。 |
| C.8 定向命令：file-locks unit、files.scheduler integration、tool-scheduler unit | 最终 3 文件、83 项通过（7＋15＋61）。涵盖最终源码和新增测试；不把定向复验说成又一次全量。 |
| 真实 HTTP＋LLM：`OHBABY_RUN_REAL_FILE_TOOLS=1 pnpm exec vitest run --config tests/smoke/file-tools-real.vitest.config.ts` | 1 项通过，约 40 秒；本进程启动真实 HTTP listener 和 persistent runtime，Zenmux `openai/gpt-5.6-luna` 共 9 次请求。Read cursor 续读、Grep、Edit、Write 均完成，磁盘两文件内容核验通过，无审批错误。密钥仅由现有夹具读取 `.env`，未输出或提交。 |
| composition E2E：`pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts` | 8 项通过，回归前置 A 的真实父子 composition 完成链；不是 C2 跨文件调度验收。 |
| Shell 回归：C.8 所列 shell-job-registry unit/integration、shell unit 三文件 | 32 项通过；本次未改 Shell，不将它们当作 C3 新能力的通过证据。 |

真实模型证明正常文件调用链未被破坏；不可依赖模型稳定制造的取消、超时和迟到写入竞态，使用可控 Promise、fake clock 及真实 scheduler→Write/Edit→延迟 rename 的专门回归验证。延迟 rename 是可控注入，其实际落盘仍调用原 fs.rename；成功/失败均验证保护持续到真实结束、临时文件被清理。

首次构建和 lint 分别发现新增测试未处理工具同步返回类型、无 await 的 async 回调等问题，均已修正；锁的等待取消将非 Error reason 包为带 cause 的英文 Error，普通 AbortController 的 Error reason 保持原对象。最终全量 `pnpm lint`、`pnpm typecheck`、`pnpm build`、五个变更源码/测试文件的 Prettier 和 `git diff --check` 均通过。真实模型 E2E 早于这项非 Error reason 规范化；最终定向用例覆盖其后版本。

## 独立审查

只读子代理对照本次完整 diff 与 C1 需求，Standards/代码质量和 Spec 均通过，无必须修复项。建议将释放与取消竞态用例增加 holder-started 屏障，已补强并通过最终定向复验。

Pi 按用户指定渠道使用 `opencode/claude-opus-5-5`、medium，独立会话 `codex-pre-c1-review-20260925-68b11ba2`，启动目录为仓库根目录。最终结论：没有必须修复的缺陷，C1 锁层成立，可以分批 commit。Pi 独立运行锁单元和文件工具集成 7＋15 项通过，并检查了迟到失败无未处理拒绝的反例；没有代替主任务重跑全量构建或 E2E。原始回复已完整呈现在实施会话。

建议的处理：

- 同规范化路径不可重入，嵌套等待会死锁：采用接口注释明确约束，不引入 AsyncLocalStorage 或重入检测；现有 Write/Edit 调用方没有嵌套取锁。
- 等待中的非 Error abort reason 会包装为 Error，预先取消沿用 `throwIfAborted` 的原始 reason：保留现状，内置 scheduler 使用 Error/DOMException，不扩大本批错误契约。
- 收紧 scheduler 等待取消的结果断言，删除已取消 controller 上没有效果的重复 abort；授予前取消的确定性交错测试保留。
- 不合作操作可能长期占据文件与旧全局写槽：已在本记录保留限制中说明；C2/C3 必须组合验证资源保护和名额归还，不在 C1 偷跑一半。

Pi 建议收尾只改接口注释和测试断言，没有进一步改运行行为；锁单元＋文件工具集成再次 22/22 通过，变更文件 ESLint、Prettier、diff 检查通过。

## 修改文件

| 文件（相对仓库根目录） | 内容 |
|---|---|
| `packages/ohbaby-agent/src/tools/utils/file-locks.ts` | 真实操作尾节点与等待取消；删除锁内超时。 |
| `packages/ohbaby-agent/src/tools/write.ts`、`edit.ts` | 将原执行 signal 传入锁；其余大块 diff 是 Prettier 缩进。 |
| `packages/ohbaby-agent/src/tools/utils/file-locks.unit.test.ts` | 锁寿命、取消、后继、迟到错误、授予竞态与监听清理。 |
| `packages/ohbaby-agent/src/tools/files.scheduler.integration.test.ts` | 两个等待取消接线回归、四个超时后延迟 rename 成功/失败回归。 |

本机可复查日志目录：`/tmp/ohbaby-pre-c1-20260925/`。临时日志不是长期测试依赖；可重复执行的测试均在上述仓库文件。真实模型脱敏证据由原有夹具写入忽略目录 `.ohbaby/test-evidence/pre-b/real-http.json`（本次日期 2026-09-25、9 次请求），该目录名沿用夹具，不表示复用了旧运行结果。

## 本地提交与结论

| 提交 | 批次 |
|---|---|
| `e20ca9e0` | 锁的真实 operation 寿命、等待取消与锁层单元回归。 |
| `5d030c02` | Write/Edit 信号接线及 scheduler 文件工具集成回归。 |
| 本记录所在文档提交 | 验收结论、测试与平台边界、前置索引链接。 |

提交前最终两文件 22 项复验通过；两批源码提交的仓库 hooks 均重新执行全量 lint/typecheck 并通过。独立子代理已复审 Pi 建议的小范围收尾，仍为零遗留发现。

结论：**C1 锁层实施与本地验收通过，完整 C 组合验收尚未完成。** 保留本地临时分支，开发分支仍为 `68b11ba2`，不合并、不推送。

## 保留限制

C1 不是完整 C 的交付：旧 scheduler 的全局写槽仍可能被不合作写入长期占用，不能据本次锁层的不同文件独立性声称真实 scheduler 已支持跨文件推进。读写准入、容量归还、目录与符号链接共享保护、异常等待结算、Bash 清理归 C2/C3；本次不覆盖 C02–C12、C14/C15 的完整组合门。

保护仅在同进程合作调用之间有效，不提供跨进程或跨重启锁。测试在 macOS arm64 执行；不声称已取得 Windows/Linux 原生验证。C3 所需真实 Windows 进程终止证据不属于本次锁层验收。
