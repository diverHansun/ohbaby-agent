# 讨论记录与已确认要点

> 2026-11-22 与用户讨论定稿。设计细节见同目录的模块文档和 `frontend/`。

## 1. 背景

用户希望在 Web 输入框里直接说话输入，不用打字。最初的想法是边说边把文字写进输入框（未确定的部分用斜体），说完再转成正常字体。讨论后发现 `<textarea>` 不能显示局部斜体，要换成富文本编辑器，波及 10 个文件，代价太大，于是改成和 Codex 一样：录音时只显示波形，不显示中间文字。

## 2. 已确认：交互

| 决策项 | 结论 |
|---|---|
| 布局 | 照 Claude App：波形放在输入框底部那一行控件的空白处，在输入卡片内部 |
| 中间文字 | 不显示，和 Codex 一样只显示波形。云端和本地识别都这样 |
| 录音期间 | 输入框照常可以编辑，底部控件照常显示；麦克风按钮变成"停止"状态 |
| 停止后 | 识别出的文字插到光标处；没有光标就接在末尾 |
| 取消 | 按 Esc 取消，丢弃这次录音 |
| 发送 | 不自动发送 |
| 端 | 只做 Web，不做 TUI |

## 3. 已确认：识别服务

| 决策项 | 结论 |
|---|---|
| 云端模型 | 阿里云百炼 `qwen-audio-3.1-asr-flash-message`（短语音输入专用的实时模型） |
| 云端接口 | WebSocket，边说边传，不用百炼自家的 HTTP 格式，也不用 `qwen3-asr-flash` 的 OpenAI 兼容接口 |
| API key | 用户在设置的 Audio 分区里自己填，留在 daemon，不发给浏览器 |
| 本地模型 | Qwen3-ASR-0.6B int8（sherpa-onnx 版本），等 App 端做完再接入，模型由 App 自动下载 |
| 本地识别方式 | 录完再识别，不能边说边出字，界面同样只显示波形 |

### 3.1 本地模型为什么选 Qwen3-ASR

用户的原则是"Qwen3-ASR 在 CPU 上能用，就选它"。sherpa-onnx 官方文档的实测数据（2026-11-22 查阅）：

| 模型 | int8 体积 | 速度（RTF，越小越快） | 语言 |
|---|---|---|---|
| Qwen3-ASR-0.6B（`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`） | 约 940MB | 2 线程 0.08–0.17 | 30 种语言 + 22 种中文方言，支持热词 |
| SenseVoice Small | 约 228MB | 1 线程约 0.1 | 中、英、日、韩、粤 |
| Fun-ASR-Nano | 约 950MB | 2 线程 0.16–0.18 | 和 Qwen3 同量级，没有优势 |

RTF 0.1 表示 10 秒的话要算 1 秒。Qwen3 说 10 秒大约等 1–1.7 秒，可以接受。两份数据的测试机器没写，只能粗比：Qwen3 的计算量大约是 SenseVoice 的两三倍。

Qwen3-ASR 官方仓库没有写 CPU 最低配置，官方运行方式是 GPU（vLLM），CPU 上要用 sherpa-onnx 转换的版本。建议的最低门槛是 8GB 内存、近五年的 4 核 CPU（Apple M1、Intel 8 代及以上），**这是推断**，App 阶段要在旧机器上实测确认。

接入时要注意三点：第一次使用要下载约 1GB；官方的流式识别只支持 vLLM，本地只能录完再识别；要配 Silero VAD 切掉静音，因为 Qwen3 是边识别边生成文字的模型，喂给它静音可能编出字。

## 4. 已确认：存放位置

照搬 ohbaby 现有的 Tavily 搜索配置做法（`~/.ohbaby/tools/search.json` 只存密钥变量名，密钥本身在 `~/.ohbaby/.env`）。所有路径都跟着 `OHBABY_HOME` 走。

| 内容 | 位置 |
|---|---|
| 语音配置 | `~/.ohbaby/audio.json`，和 `model.json` 同级。不放 `tools/`，因为语音不是给 agent 调用的工具 |
| 百炼 API key | `~/.ohbaby/.env`，配置里只记 `apiKeyEnv` |
| 本地模型权重（App 阶段） | `~/.ohbaby/models/asr/qwen3-asr-0.6b-int8-2026-03-25/` |
| VAD 权重（App 阶段） | `~/.ohbaby/models/vad/silero/` |

本地权重下载照 deepseek-harness 的做法：固定 SHA-256 校验，下载源先试 huggingface.co，不通再换 hf-mirror.com。

## 5. 已确认：文档写法

| 议题 | skill |
|---|---|
| 本议题（新功能） | `plan-module-design` 写模块文档；前端用 `plan-frontend-design` 精简模式 |
| [输入框模型与思考强度合并](../2026-11-22-composer-model-effort/README.md) | `plan-code-improvement` |

## 6. 明确不做

| 项 | 原因 |
|---|---|
| 边说边显示文字、斜体 | `<textarea>` 做不到，换富文本编辑器代价太大 |
| 把预览文字放在输入框下方单独一行 | 界面层次变多，用户不想要 |
| 录音时用波形替换底部整排控件、只留停止按钮 | 录到一半想改控件就得先停，用户不想要 |
| OpenAI Whisper 作为本地模型 | 中文效果比 Qwen3-ASR、SenseVoice 差 |
| TUI 语音输入 | 不做 |

## 7. 参考项目用的识别方案

| 项目 | 模型 | 做法 |
|---|---|---|
| deepseek-harness | SenseVoice Small（ONNX）+ Silero VAD | 纯本地，跑在 sherpa-onnx 里，录完再识别。权重在 `dataRoot/models/sensevoice-onnx`（`packages/experimental/speech-to-text-sensevoice/src/runtime.ts:59`），下载源是 huggingface.co 和 hf-mirror.com（`config.ts:64`） |
| ZCode | 由服务端决定，客户端选不了 | 服务端 `default_provider` 决定，文档提到火山实时识别，超时设置单独提到 GLM（`docs/chat/composer-voice-input.md:57`）。没有设置页，不用填 key |
| kimi-code | 没有语音输入 | 无 |
| Claude Code | Anthropic 自家语音识别或豆包 | `docs/features/voice-mode.md`，按住说话，边说边出字 |

deepseek-harness 的路径相对 `../deepseek-harness/`，ZCode 相对 `../ZCode/`，Claude Code 相对 `../claude-code/`。
