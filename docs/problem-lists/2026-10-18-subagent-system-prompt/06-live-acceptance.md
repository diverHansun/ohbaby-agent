# 浏览器与真实请求验收

2026-10-19，在 `feat/subagent-system-prompt@e60a1273` 上补做在线验收。浏览器使用本次已构建的 CLI/Web，另外按 `tests/models-4-tests.md` 选择三个 ZenMux 协议入口。模型回复、工具读取、压缩和 SQLite 均为真实链路，没有替换模型结果。

结论：本批提示词调整未发现阻断问题。主、子代理收到说明并遵守项目优先规则；同一子代理跨进程恢复成功；三协议的正式压缩、上下文恢复及实际缓存用量核对通过。本轮只修正测试夹具的两处旧假设，没有调整生产代码，也没有开始 system-reminder。

## 浏览器：编译产物、子代理与进程重启

在本代理拥有的进程内运行 `packages/ohbaby-cli/dist/bin.js serve`，使用临时项目、独立 `OHBABY_HOME` 和 SQLite。预加载观测器仅记录哈希、受控标记和用量；凭据不写入配置或证据。

测试全局 `CLAUDE.md` 指定 npm 和一个回答标记；项目 `AGENTS.md` 指定 pnpm、仅报告的检查命令和另一个标记。这些内容没有写进浏览器提交的问题或子代理委派提示。

| 操作 | 实际结果 |
| --- | --- |
| 主代理读取 `note.md`，创建 Explore 子代理独立读取 | 两者均答出 Cedar / Lin / 17，选择 pnpm 和 `pnpm verify-fixture`，各自附加说明中的 V1 标记 |
| 更新项目文件为 V2，在同一会话继续原子代理 | 主、子新 run 的 system 使用 V2，旧版本不再注入；模型回答遵守 V2 |
| 停止 PID 7261，确认端口释放，再用 PID 9711 和原数据库启动 | 浏览器重新载入后继续同一子代理；它不读文件即可答出原项目事实，并遵守 V2 |
| 停止第二个进程 | 两个进程均退出，59859 端口释放；浏览器离开已停止的服务 |

数据库只有一个主会话、一个子会话和一个子代理实例；三次子执行的 `delegation_sequence` 是 1、2、3，六个主／子 run 全部 succeeded。此次恢复时执行目录与项目根相同，不能替代 S8 中“保存根 A、执行目录 B”的恢复专项。

共 11 次 HTTP，其中 10 次为主／子 agent 请求，全部 200。独立子代理交叉核对了最终请求和数据库：

- 10 次 system 均为 Global 标记一次、当前 Project 标记一次，Global 在 Project 前，无自动 `<memory>`。
- 同 run 的 system、tools 和已有消息前缀保持一致；重启后的 V2 system 与重启前逐字一致，历史前缀继续保留。
- 工具调用／结果配对六项异常计数均为零。恢复后的三个请求均含独立 user runtime context；数据库有六个相应 runtime part。
- 10 次 agent 请求中 9 次有真实 cache read，累计 **55,296 / 75,769 input tokens**。恢复后的主、子首次请求分别命中 **10,496 / 10,762** 和 **4,224 / 4,442**；raw usage 与落库用量一致。这个样本不证明未来命中率，也没有验证 cache write。

证据：[浏览器请求与持久化摘要](./evidence/browser-requests.json)。本地截图、页面快照及启动脚本保留在 `.ohbaby/subagent-browser-acceptance/`，不提交 SQLite、配置或完整请求正文。

## 请求：三协议压缩、恢复与 cache hit

复用生产 persistent backend 的真实 smoke harness，执行：读取 → 续聊 → public force compact → 压缩后续聊 → dispose / SQLite reopen → 再续聊。修正夹具后的三个测试均退出 0；另用四次 HTTP 对 Anthropic 前缀做了专项核对。包括首轮尝试在内，请求层共 49 次 HTTP，浏览器另有 11 次。

`currentTokens` 是产品 Context 用量记录；cache read 列来自真实接口返回并经独立核算，不能将两者当成同一种统计。

| 协议／模型 | 压缩前 → 后 currentTokens | 压缩后首次 cache read | 重开后 cache read / 总 input |
| --- | ---: | ---: | ---: |
| OpenAI Compatible / `deepseek/deepseek-v4.1-flash` | 40,973 → 10,015 | 8,832 | 9,984 / 10,229 |
| OpenAI Responses / `openai/gpt-5.6-luna` | 38,705 → 9,237 | 7,465 | 8,149 / 8,315 |
| Anthropic / `anthropic/claude-sonnet-5` | 59,286 → 14,824 | 0 | 15,593 / 15,813 |

三种协议均生成真实摘要并落库，旧 Part / native state 退出有效历史；已退休的 native 不再进入请求。压缩后仍能回答负责人，重开后能回答项目与负责人，活动 native 指纹与状态集合在重开前后相同。主身份与项目说明在实际请求、摘要请求和恢复后仍存在；system/tools 保持稳定。

Chat 和 Responses 在普通续聊中保留精确消息前缀，压缩后前缀按设计改变。Anthropic 的原始消息 JSON 会因 `cache_control` 断点移动和等价文本包装变化而改变：短链路补测在仅去除断点、统一 string / text-block 包装后得到相同前缀。不能把这个结论写成 Anthropic 原始请求逐字节不变，也不能据此声称正式长压缩链路的每个语义前缀都已单独核对。实际 cache read 证明该链路确实复用了缓存；压缩后首次为零也如实保留。

原始 usage、归一化 usage、主请求落库值及 `/status` 累计均逐项对得上。Anthropic 的原始 `input_tokens` 不含缓存桶，例如恢复请求为 `2 + 15,593 read + 218 write = 15,813`。新 backend 的累计统计按既有 improve-5 K6/T8 合同从零开始，历史和 native 恢复不受影响。

证据：[三协议核算记录，含首轮失败](./evidence/context-cache-audit.json)。本地完整脱敏 wire、复现脚本及日志在 `.ohbaby/test-evidence/2026-10-19-live-context/`；其中 `README.md` 记录准确命令，`manifest.json` 记录文件清单。

## 本轮发现与处理

1. **旧压缩夹具过短。** 30/60 条重复材料不足以越过当前 20k 保留阈值，产品正确返回 `not-needed / too-short`。增为 300/600 后，三个协议都走完同一正式压缩入口，未降低产品阈值或放宽压缩断言。
2. **旧 read 分类器误拒合法参数。** Responses 实际生成了 `read({file_path, limit})`。修正测试分类器，保持精确受控路径及只读工具限制，接受生产合法的读取选项，仍拒绝未知键、非法参数或其他文件。没有为了匹配断言而强迫模型只传单参数。
3. **既有前端计时诊断。** 两个服务进程各观察到一条 `duration-clock` 日志，子代理正常完成。独立审查发现该路径在此前 improve-6 验收已有同类记录，本批未改 Web/SDK 计时代码；定向测试 7 条通过。可能是子代理状态比主会话的时间样本更新，日志不足以还原精确时差。不能宣称控制台零错误。
4. **观测器限制。** 浏览器标题辅助请求为 200，但 response stream 观测失败，没有可用 usage，不计入 agent 缓存统计。首个进程的 runtime 检查标签写错，已从归档中移除该无效布尔值；恢复进程使用正确标签，并用数据库交叉核对。

首轮三份夹具断言失败和 Responses 的一次 failed skill 调用均保留，未把“重跑通过”改写成“首次全部通过”。服务重启期间的断连／旧令牌 401，在重新载入页面取得新 bootstrap 后恢复。

本轮不覆盖百万窗口自然达到自动压缩阈值、上游 overflow、远端 sandbox、真实 worktree，或文件在活跃 run 中途改变的在线服从性；后者仍由已有确定性快照测试覆盖。浏览器只抽测 DeepSeek 的真实子代理，三协议子代理请求结构继续以已有确定性集成测试为依据。

## 检查与提交

测试夹具独立提交为 `795f0c79`。新增分页回归先在旧分类器上失败，修正后 `formal-cache-live-context.unit.test.ts` 与 `formal-cache-observer.unit.test.ts` 共 38 条通过；Prettier、`git diff --check` 通过。提交钩子的全仓 lint 为 0 error / 122 条既有 warning，`tsc -b` 通过。

仓库默认 ESLint project service 不包含 smoke 文件。临时仅纳入本次三个文件复核时，helper 与 real E2E 无诊断，unit 文件已有的两处 `vi.waitFor` 箭头回调触发 `no-confusing-void-expression`；它们不在本轮 diff，未顺带修改。因此不声称 smoke 文件的全量 ESLint 零错误。

两个归档 JSON 已解析校验，并与本地环境凭据值比对，命中数为零。独立子代理复核了浏览器请求、持久化身份、缓存数值与本文边界，未提出新的阻断项。本轮提交只涉及测试及验收材料，未 merge、未 push。
