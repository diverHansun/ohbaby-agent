# system-reminder 最终验收

2026-10-19，分支 `feat/system-reminder`，受测代码为 `20dc4110`。五批实现、测试迁移及独立子代理审查均已完成，提交记录见 [06](./06-implementation-acceptance.md)。本次在执行进程中启动编译后的 ohbaby 服务，完成浏览器和三协议真实请求验收；没有 merge 或 push。

## 1. 全仓检查与审查

| 检查 | 实际结果 |
| --- | --- |
| `pnpm test` | 571 文件、6780 项通过；6 文件、17 项按配置跳过，212.39 秒 |
| `pnpm run typecheck` | 通过；与会重建 dist 的 CLI 测试串行执行 |
| `pnpm run lint` | 0 errors，122 条既有 warnings |
| agent 包 `prompt:check` | 通过，生成资产与源文案一致 |
| `pnpm build` | 通过，CLI 内含本轮构建的 Web 资源；保留 Vite 大于 500 kB 的 chunk 提示 |
| 独立审查 | 每批通过；整体生产范围 `8a16f5e2..f1d9b24d` 审查无阻塞项，额外 8 文件、264 项测试通过；测试迁移另行审查通过 |

首次全仓回归的 35 项失败已在 `20dc4110` 修正，只有 7 个旧测试文件发生变化，没有为迁就旧断言修改生产实现。测试继续验证原始输入、工具结果、作用域、Goal 准入和压缩恢复，并明确区分内部提醒与界面可见消息。

## 2. 编译服务浏览器验收

使用隔离配置、项目和 SQLite；API key 从仓库 `.env` 读取，没有写入隔离配置。初次启动命令：

```sh
node --import tsx --import ./.ohbaby/reminder-implementation/browser-preload.mts packages/ohbaby-cli/dist/bin.js serve --port 0 --no-open --mode auto
```

进程 PID 28619，实际端口 60642。之后停止进程，指定同一隔离根 `OHBABY_BROWSER_RESUME_ROOT`，以同一编译入口、端口 60642 重启为 PID 34111。两个进程均已正常停止，最终确认端口没有监听者。preload 仅用于隔离环境和观察请求，不替换 agent 实现。

| 操作 | 观察结果 |
| --- | --- |
| 主代理读取 `note.md` | 实际 read 工具完成，回答 Cedar／17／Lin；Global、Project 标记各一次，项目约定使用 pnpm |
| auto → plan → auto | 浏览器切换后回复反映当前模式；主 system 哈希始终一致，新的 auto 提醒明确旧 plan 约束结束 |
| 创建 Explore 子代理 | 子代理实际读取同一文件；拥有自己的 environment，没有主代理 mode |
| 停服、同库重启并重新加载页面 | 主历史恢复，原 Explore 实例再次执行；从历史回答 Release 17 和项目检查命令，没有新增 read |
| 查看子代理旧历史和续答 | 旧任务、read 工具结果及新委派均可见；主页面、子代理弹窗均未展示内部 synthetic 提醒 |

SQLite 中仍为一个主会话、一个子会话和一个 subagent 实例；4 个主 run、2 个子 run 均成功。仅有主、子首轮各一次 read。恢复前后的 **5 个提醒 part 全部保留**：主 environment 1 条、mode 3 条，子 environment 1 条。其 ID、正文哈希、key、anchor 和 scope 逐项一致，无缺失、无改写、无新增重复。主、子各有一份活动 environment；主含 OS version／cwd／date，子含 cwd／date，不含 OS version。本样本没有跨天或改变目录。

10 次 agent 请求中，Global 和 Project 标记均各一次，渲染顺序为 Global → Project；同身份的 system 哈希在重启前后稳定。11 次模型 HTTP（含 1 次标题）均为 200；10 次 agent 请求中 9 次 cache read 大于 0，合计 read **67,072 / 77,754 input tokens**。重启后首次主请求为 **9,856 / 10,062**，子请求为 **3,968 / 4,188**。这些是样本结果，不是命中率保证。

控制台有 **2 条 `duration-clock` 的 `ui.observation.failure`**，分别对应两次子代理执行；前一批验收已记录同类现象，本轮未分析根因。停服期间另有断连记录，重启后旧 bootstrap 曾返回 401；重新加载页面后主、子续跑成功。不能将本次描述为“控制台零错误”，这些记录也不等同于模型 HTTP 失败。

## 3. 三协议真实请求与缓存

按照 `tests/models-4-tests.md` 的测试配置，分别使用 Chat、Responses、Anthropic 真实接口。每个流程均经历工具读取、plan → auto、补充历史、实际手动压缩、压缩后回答、SQLite 关闭／重开及再次回答；均在首次执行通过。

| 协议／模型 | HTTP（生成请求） | 主步骤 read > 0 | 主步骤 read / input 合计 | 压缩后首请求 read | 重开后 read / input |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chat／deepseek/deepseek-v4.1-flash | 10（9） | 7/7 | 107,904 / 149,293 | 8,960 | 9,728 / 9,879 |
| Responses／openai/gpt-5.6-luna | 10（9） | 5/7 | 90,654 / 137,564 | 0 | 8,140 / 8,190 |
| Anthropic／anthropic/claude-sonnet-5 | 10（9） | 5/7 | 148,457 / 223,644 | 0 | 15,192 / 15,232 |

共 30 次 HTTP 全部 200。每协议含 7 次 agent-step、1 次标题、1 次 context-summary 和 1 次模型 metadata 请求。表内累计仅含主步骤；零命中原样保留。

### 压缩与请求变化

| 协议 | 产品 currentTokens，压缩前 → 压缩完成后 | 摘要数／字符数 | 退休 part／native 数 |
| --- | ---: | ---: | ---: |
| Chat | 40,655 → 9,754 | 1／1,512 | 13／2 |
| Responses | 38,013 → 9,205 | 1／1,514 | 12／3 |
| Anthropic | 59,233 → 14,514 | 1／2,105 | 10／1 |

currentTokens 来自产品的 contextUpdates，不能与接口计费 input tokens 混用。三个流程均实际调用摘要模型并提交退休记录；重开前后的活动、退休 native 哈希集合相等，最终请求没有回放已退休 native。重开前活动 native 数分别为 2／3／0，因此本次 Anthropic 不构成“恢复了非空 native 状态”的证据。

三协议各有 6 次相邻主请求比较：5 次不跨压缩，1 次跨摘要。Chat／Responses 的 5 次非压缩过渡保留完整原始 input 前缀；Anthropic 原始 JSON 会因 cache_control 落点或合法文本表示变化而不同，仅删除 cache_control、将字符串 content 包装为等价 text block 后，5 次前缀全部一致。此规范化没有删除 native／signature，也没有重排数组。三者跨压缩前缀均按预期改变；主步骤和摘要请求的 system、tools 哈希各自保持单一值，标题不参与该比较。

### mode 位置与 Anthropic 风险抽测

三个流程均在 read 已准备时切换为 auto：已准备请求仍保留 plan，下一次工具续步首次追加 auto 提醒。Anthropic 实际线报文将完整 tool_result 放在同一 user 回合的 block 0，新 auto 提醒位于并列 text block 1。

该 Anthropic 请求 HTTP 200，完整 SSE 含 message_start 和 message_stop，stop_reason 为 `end_turn`，产生 **205 字符可见正文**，正确回答 Cedar／17／Lin，没有工具调用。因并列提醒而空 `end_turn` 的风险在这个样本中未复现；这不代表所有模型和任务均已排除风险。请求摘要为 `3a40da88e4456fe491fdb3f62aeedf3ce0b10d18135c15adf80d8b7b70f9ad72`。

### usage 数值链

独立复核原始 usage 帧 → 汇总 usage → provider 记录，**27/27 次生成请求数值一致**。各协议 SQLite 中 7 个主步骤 usage 的完整数值多重集合与 provider 相同，包含重复次数；证据没有 request → part 身份映射，不声称逐条 part 身份对应。

所有检查点的 `/status` 与当前 backend 的主步骤累计一致，标题／摘要不计入；重开后进程内累计重新开始，SQLite 中仍保留全部 7 步 usage。Anthropic 重开请求为 `2 uncached + 15,192 read + 38 write = 15,232 input`。Chat 的 write=0 未被上游明确报告，不能据此认定远端没有写缓存。

## 4. 覆盖边界与证据位置

真实模型抽测覆盖一次**手动压缩**及恢复，没有等到百万 token 窗口的自然自动压缩。重试／崩溃／提交冲突、旧会话升级、Todo 9／10 周期、skill 失败及压缩事件、兄弟作用域组合等，依据分批确定性测试和整体审查，不冒充真实接口已逐项执行。浏览器使用 DeepSeek；其他两协议的真实验证在请求层完成。

本轮保留本地证据，不纳入 Git 的目录如下；临时文件不是永久归档承诺：

- `.ohbaby/reminder-implementation/`：各批报告、整体审查、真实 API／浏览器独立复核、前后 SQLite 摘要、DOM、截图、控制台、请求审计及凭据扫描结果。
- `.ohbaby/test-evidence/2026-10-19-system-reminder/`：三个主证据文件及各自的 `.reminders.json`，文件名见下表。
- 浏览器隔离根：`/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/ohbaby-reminder-browser-uoJx8P`，保留 SQLite、隔离配置和两次请求观察。
- `/tmp/reminder-full-tests-final.log`、`/tmp/reminder-final-build.log`：完整回归及构建日志。

| 协议 | 真实请求证据文件 |
| --- | --- |
| Chat | `zenmux-deepseek-v41-chat-compaction-1792403773812.json` |
| Responses | `zenmux-gpt56-luna-responses-context-compaction-1792403856518.json` |
| Anthropic | `zenmux-claude-sonnet5-anthropic-context-compaction-1792403864572.json` |

凭据检查使用 `.env` 中 key／token／secret 字段的 5 个实际值进行精确匹配，覆盖上述验收目录、浏览器隔离根、本轮日志及验收文档，结果为 **0 命中**；没有缺失的扫描根或跳过的符号链接，记录见本地 `credential-scan.json`。该检查不输出凭据值。
