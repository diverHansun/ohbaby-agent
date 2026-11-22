# 语音输入：数据模型

> 本模块的数据很少：一份长期保存的配置，加上一次录音期间只活在内存里的会话。录音和识别结果都不落盘。

## 1. 概念总览

| 概念 | 活多久 | 存在哪 | 谁拥有 |
|---|---|---|---|
| 语音配置 | 长期 | `~/.ohbaby/audio.json` + `~/.ohbaby/.env` | ohbaby-agent `config/audio/` |
| 设置视图（`UiSettingsAudio`） | 每次请求 | 只在 HTTP 响应里 | daemon 设置接口 |
| 录音会话（浏览器侧） | 一次录音 | 浏览器内存 | `useVoiceInput` |
| 录音会话（daemon 侧） | 一条语音 WebSocket 连接 | daemon 内存 | `VoiceSession` |
| 识别任务 | 一次 `run-task` | daemon 内存 + 百炼 | `SpeechTask`（引擎实现） |
| 识别结果 | 插进输入框为止 | 输入框草稿 | 草稿本身（之后按草稿规则保存） |

```
语音配置 ──读──▶ VoiceSession ──创建──▶ SpeechTask ──产出──▶ 识别结果（一段文字）
                    ▲                                          │
浏览器录音会话 ──1:1 WebSocket 连接──┘                          ▼
                                                    浏览器插入输入框草稿
```

一次录音 = 一个浏览器录音会话 = 一条 WebSocket 连接 = 一个 `VoiceSession` = 一个 `SpeechTask`。四者同生同灭，没有复用。

## 2. 语音配置

### 2.1 `audio.json`

```json
{
  "provider": "dashscope",
  "dashscope": {
    "baseUrl": "https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com",
    "model": "qwen-audio-3.1-asr-flash-message",
    "apiKeyEnv": "OHBABY_AUDIO_API_KEY",
    "disfluencyRemoval": true,
    "languageHints": []
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | `"dashscope"` | 本轮只有这一个值。App 阶段加 `"local"` |
| `dashscope.baseUrl` | 字符串，可缺省 | 百炼控制台给出的地址。接受 `https://` 或 `wss://`，引擎只取其中的主机名，拼成 `wss://<主机>/api-ws/v1/inference` |
| `dashscope.model` | 字符串 | 默认 `qwen-audio-3.1-asr-flash-message` |
| `dashscope.apiKeyEnv` | 字符串或 `null` | `.env` 里存 key 的变量名。配置里只记名字，不记 key |
| `dashscope.disfluencyRemoval` | 布尔 | 对应百炼的 `disfluency_removal_enabled`，去掉"嗯、啊"等口头语 |
| `dashscope.languageHints` | 字符串数组，最多 4 个 | 对应百炼的 `language_hints`，例如 `["zh", "en"]`。空数组表示让模型自己判断 |

按服务商分一层（`dashscope: {…}`），是为了 App 阶段加 `local: {…}` 时，用户在两种引擎之间切换不会丢掉另一种的配置。文件里未知的字段原样保留，和 `search.json` 一样。

### 2.2 API key

key 写进 `~/.ohbaby/.env`，变量名记在 `dashscope.apiKeyEnv`。写法和搜索的 Tavily key 一致（`config/tools/search/writer.ts` 的 `updateSearchSettings`）：

| 情况 | 做法 |
|---|---|
| 首次保存 key | 变量名默认 `OHBABY_AUDIO_API_KEY` |
| 默认名已被模型或搜索配置占用 | 依次试 `OHBABY_AUDIO_API_KEY_2`、`_3`… |
| 用户清空 key | 只删本模块自己管理的变量（名字匹配 `OHBABY_AUDIO_API_KEY` 或带数字后缀）；其他名字只断开引用，不删变量，因为它可能属于用户自己或别的配置 |
| 改变量名 | 不删旧变量 |

为了互不冲突，`collectCredentialReferences`（`config/secrets/references.ts`）要能收集三方的变量名：模型、搜索、语音。三个写入方都要把另外两方的变量名当作"已占用"。

## 3. 默认值与校验

| 字段 | 默认值 | 校验 |
|---|---|---|
| `provider` | `"dashscope"` | 只能是 `"dashscope"` |
| `baseUrl` | 无（必须由用户填） | 合法 URL，协议是 `https`、`http`、`wss` 或 `ws` 之一 |
| `model` | `qwen-audio-3.1-asr-flash-message` | 非空字符串 |
| `disfluencyRemoval` | `true`（**待用户确认**，见 README） | 布尔 |
| `languageHints` | `[]` | 最多 4 个，每个非空 |

`baseUrl` 不给默认值：百炼新版地址里带工作空间 ID（`<WorkspaceId>.cn-beijing.maas.aliyuncs.com`），每个用户都不一样，猜不出来。旧的公共地址 `dashscope.aliyuncs.com` 是否还能用于这个模型，要在实施时用真实 key 核实；能用的话再把它设为默认值。

"已配置"的判断由 daemon 做：`provider` 是 `dashscope`、`baseUrl` 有值、`apiKeyEnv` 指向的变量有值，三条同时成立。判断结果放在设置视图的 `configured` 字段里，前端不自己推算，这样 App 阶段换成本地引擎时（判断条件变成"模型已下载"），前端不用改。

## 4. 设置视图（SDK 类型）

放在 `packages/ohbaby-sdk/src/contract/settings.ts`，照 `UiSettingsSearch` 的写法。界面只有一个服务商，所以视图是扁平的，不暴露 `audio.json` 里按服务商分的那一层。

```ts
interface UiSettingsAudio {
  provider: "dashscope";
  baseUrl: string | null;
  model: string;
  apiKeyEnv: string | null;
  apiKeyConfigured: boolean; // 只告诉有没有，不返回 key
  disfluencyRemoval: boolean;
  languageHints: string[];
  configured: boolean; // 见 §3，能不能开始录音
}

interface UiSettingsAudioUpdate {
  provider?: "dashscope";
  baseUrl?: string | null;
  model?: string;
  apiKeyEnv?: string | null;
  apiKey?: string; // 不传表示不改；"" 表示清空
  disfluencyRemoval?: boolean;
  languageHints?: string[];
}

interface UiSettingsAudioResponse extends UiSettingsAudio {
  ok: true;
}
```

## 5. 录音会话

### 5.1 浏览器侧

状态机见 [前端 04 §1](frontend/04-interaction-and-states.md)。这里只列它持有的数据：

| 数据 | 说明 |
|---|---|
| `MediaStream` | 麦克风流。结束、取消、出错时都要停掉所有轨道，浏览器标签上的录音提示才会消失 |
| `AudioContext` + AudioWorklet | 把麦克风音频重采样成 16kHz 单声道 16 位 PCM，每 100ms 交出一块（3200 字节），同时算出这一块的音量 |
| 待发队列 | 收到 `started` 之前产生的 PCM 块。大小由开始超时限住，见 [non-functional §2.1](non-functional.md) |
| 音量历史 | 画波形用的最近若干个音量值，只保留画得下的数量 |
| 开始时间 | 计算录音时长，到上限自动停止 |
| WebSocket | 一次录音一条 |

### 5.2 daemon 侧（`VoiceSession`）

| 数据 | 说明 |
|---|---|
| 状态 | `waiting_start` → `streaming` → `finishing` → `closed` |
| `SpeechTask` | 引擎返回的任务句柄 |
| 已收音频字节数 | 超过上限（约 6 分钟的数据量）就报 `too_long` 并结束 |
| 计时器 | 开始超时、结束超时、总时长上限 |

daemon 不缓存音频：`started` 之前浏览器不发音频，`started` 之后收到一块就转给引擎一块。

## 6. 识别结果

百炼每识别完一句，发一条 `sentence_end = true` 的 `result-generated`。引擎把这些句子按顺序拼起来，在 `task-finished` 时交出一整段文字：

| 规则 | 说明 |
|---|---|
| 只取完整的句子 | 只要 `sentence_end = true` 的结果；`heartbeat = true` 的跳过 |
| 拼接 | 直接连起来。只有前一句以拉丁字母或数字结尾、后一句以拉丁字母或数字开头时，中间加一个空格 |
| 首尾空白 | 去掉 |
| 空结果 | 交出空字符串，前端提示"没听清" |

插进输入框时的空格处理（比如光标前面是英文单词）见 [前端 04 §4](frontend/04-interaction-and-states.md)。

## 7. 不保存的数据

| 数据 | 处理 |
|---|---|
| 录音音频 | 只在内存里转发，连接关闭就丢 |
| 识别出的文字 | daemon 不记日志、不存盘；交给浏览器后就忘掉 |
| 用量（`usage.duration` 等） | 本轮不记录、不展示 |
