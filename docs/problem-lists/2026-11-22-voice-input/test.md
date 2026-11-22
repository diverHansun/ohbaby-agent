# 语音输入：测试设计

> 遵循项目现有的测试分类：单测和集成测试用 Vitest，文件名分别以 `.unit.test.ts(x)` 和 `.integration.test.ts(x)` 结尾，放在被测代码旁边或包内的 `__tests__/`。以用户操作为中心的前端验收见 [前端 08](frontend/08-test-and-acceptance.md)。

## 1. Test Scope

| 测 | 不测 |
|---|---|
| 语音配置的读写、key 的写入和清空、变量名冲突 | 百炼的识别准确率 |
| 语音连接的鉴权、协议顺序、错误码 | 浏览器的 `getUserMedia` 本身 |
| 百炼引擎对百炼协议的使用（用假的百炼服务端） | 真实网络下的延迟（只做一次手工测量，见 §4） |
| 拼接识别结果的规则 | 本地识别（App 阶段） |
| 浏览器端的 PCM 转换、状态机、插入文字 | 波形的视觉效果（浏览器走查） |

## 2. Critical Scenarios

| ID | 场景 | 层 | 验证点 | 对应 |
|---|---|---|---|---|
| T-1 | 保存配置和 key | ohbaby-agent 单测 | `audio.json` 里有 `apiKeyEnv` 没有 key；`.env` 里有 key；读回来 `apiKeyConfigured = true`、`configured = true` | D9 |
| T-2 | 变量名冲突 | ohbaby-agent 单测 | 模型或搜索已用 `OHBABY_AUDIO_API_KEY` 时，语音改用 `_2`；搜索写 key 时也避开语音的变量名 | D9 |
| T-3 | 清空 key | ohbaby-agent 单测 | 本模块管理的变量被删；用户自定义的变量名只断开引用，变量还在 | D9 |
| T-4 | 写入失败回滚 | ohbaby-agent 单测 | 写 `audio.json` 失败时 `.env` 恢复原样 | D9 |
| T-5 | 设置接口 | server 集成 | `GET`/`PUT /v1/settings/audio` 往返；校验失败返回 400；保存后发出 `settings.changed`，域里有 `audio` | D10 |
| T-6 | 语音连接鉴权 | server 集成 | 没带 token 或 token 错：4401 关闭；Origin 不对、daemon 绑在非回环地址：拒绝升级 | D6 |
| T-7 | 正常识别 | server 集成（假百炼） | `start` → `started` → 音频 → `finish` → `completed`，文字等于假百炼返回的句子拼接；假百炼收到的音频字节和发出的一致；收到的 `run-task` 参数符合 [dfd-interface §3.4](dfd-interface.md) | D6、D7 |
| T-8 | 未配置 | server 集成 | 回 `not_configured`，不去连百炼 | D6 |
| T-9 | 百炼拒绝 key | server 集成（假百炼握手返回 401） | 回 `provider_auth_failed` | D7 |
| T-10 | 百炼任务失败 | server 集成（假百炼发 `task-failed`） | 回 `provider_failed`，`message` 里有百炼的错误码 | D7 |
| T-11 | 超时 | server 单测（假计时器） | 假百炼不回 `task-started` 或 `task-finished`：分别在 10 秒、15 秒后回 `timeout` | D6 |
| T-12 | 取消和断开 | server 集成 | 浏览器发 `cancel` 或直接断开后，到假百炼的连接被关闭，没有发 `finish-task` | D6 |
| T-13 | 协议错误 | server 集成 | `start` 之前发音频、重复 `start`、不支持的 `format`：回 `bad_request` | D6 |
| T-14 | 太长 | server 单测 | 音频字节超过上限时回 `too_long`，识别任务被取消 | D6 |
| T-15 | 拼接规则 | server 单测 | 中文句子直接相连；英文和数字之间加空格；心跳和未结束的句子被跳过；全空时返回空字符串 | D7 |
| T-16 | PCM 转换 | web 单测 | 48kHz 浮点输入转成 16kHz 16 位整数，长度正确，超出 [-1, 1] 的值被截断而不是溢出 | D1 |
| T-17 | 浏览器状态机 | web 单测（假 WebSocket、假麦克风） | 前端 04 状态表里的每一条转换；收到 `started` 前的音频进队列，之后按顺序发出 | D3 |
| T-18 | 清理 | web 单测 | 完成、取消、出错、组件卸载后，麦克风轨道都已停止，`AudioContext` 已关闭，连接已关闭 | D3、non-functional §3.1 |
| T-19 | 插入文字 | web 单测 | 光标在中间、选中了一段、输入框没有焦点三种情况下插入位置正确。能否撤销依赖浏览器的"插入文本"命令，jsdom 不支持，放到浏览器走查里验证（前端 08 V-2） | D4 |

## 3. Integration Points

| 边界 | 怎么测 |
|---|---|
| 浏览器 ↔ daemon | server 集成测试用 `ws` 客户端模拟浏览器，走真实的升级和鉴权；web 单测用假 WebSocket，只验证发出的消息序列 |
| daemon ↔ 百炼 | 在测试里起一个本地 `ws` 服务端扮演百炼，能按用例返回 `task-started`、`result-generated`、`task-finished`、`task-failed`，或握手时返回 401、或不回复。百炼引擎的地址指向它 |
| daemon ↔ 配置 | 测试用临时的 `OHBABY_HOME`，不碰用户真实的 `~/.ohbaby` |
| 终端 WebSocket 不受影响 | 现有终端测试全部通过，证明加了分发器之后终端照常 |

## 4. Verification Strategy

| 方式 | 内容 |
|---|---|
| 自动化 | §2 全部用例。命令：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test:unit`、`pnpm test:integration` |
| 一次真实联调（手工） | 用真实百炼 key，在本机 Web 里说 3 段话：10 秒中文、10 秒中英混合、1 分钟中文。记录停止到出字的耗时（daemon 日志里有），核对 G1；同时核实 `baseUrl` 用旧公共地址 `dashscope.aliyuncs.com` 能不能用（见 [data-model §3](data-model.md)） |
| 浏览器走查 | 按 [前端 08](frontend/08-test-and-acceptance.md) |

真实联调需要用户提供 key，在实施会话里由用户配合完成。key 只在用户本机的设置页里填写，不写进测试代码和文档。
