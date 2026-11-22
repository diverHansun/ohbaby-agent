# 语音输入：架构

> 对应 [goals-duty](goals-duty.md) 的 G1–G5、D1–D10。代码现状截至 2026-11-22，`main` 分支 `f3b2fff9`。

## 1. Architecture Overview

```
浏览器（ohbaby-web）                       daemon（ohbaby-server）                 外部
┌──────────────────────────┐   WebSocket   ┌──────────────────────────┐  WebSocket  ┌──────────────┐
│ 麦克风按钮 / 波形          │  /v1/voice/   │ 语音路由：鉴权、协议解析   │  run-task   │ 阿里云百炼    │
│ useVoiceInput（状态机）   │──transcribe──▶│ VoiceSession（一次录音）  │────────────▶│ qwen-audio-  │
│ AudioWorklet → 16k PCM   │  PCM 二进制帧  │ SpeechEngine 接口         │  PCM 帧     │ 3.1-asr-     │
│ 插入输入框                │◀── completed ─│  ├ DashScopeEngine（本轮）│◀── 结果 ────│ flash-message│
└──────────────────────────┘               │  └ LocalEngine（App 阶段）│             └──────────────┘
          │ HTTP                           └───────────┬──────────────┘
          │ GET/PUT /v1/settings/audio                 │ 读配置、读 key
          ▼                                            ▼
┌──────────────────────────┐               ┌──────────────────────────┐
│ 设置 › Audio 分区         │──────────────▶│ ohbaby-agent config/audio │──▶ ~/.ohbaby/audio.json
└──────────────────────────┘               │ （照 tools/search 的写法）│──▶ ~/.ohbaby/.env
                                           └──────────────────────────┘
```

一句话：浏览器只负责录音、画波形和插文字；daemon 负责鉴权、拿 key、对接识别服务；配置读写放在 ohbaby-agent 的配置模块里，和搜索配置并列。

分四块，对应四个包：

| 块 | 包 | 职责（对应 goals-duty） |
|---|---|---|
| 录音与界面 | `apps/ohbaby-web` | D1–D5 |
| 中转与识别引擎 | `packages/ohbaby-server` | D6–D8、D10 的路由部分 |
| 语音配置 | `packages/ohbaby-agent`（`config/audio/`） | D9 |
| 契约类型 | `packages/ohbaby-sdk` | D10 的类型部分：设置类型、WebSocket 消息类型 |

## 2. Design Pattern & Rationale

| 决定 | 做法 | 理由 | 放弃的做法 |
|---|---|---|---|
| 浏览器不直连百炼 | 经 daemon 中转 | G3：key 不出 daemon。浏览器的 WebSocket 也不能设置 `Authorization` 头，直连只能把 key 放进地址，会泄露 | 浏览器直连；daemon 发临时票据（ZCode 的做法，但它的服务端是云端，我们的 daemon 就在本机，没必要） |
| 识别引擎可替换 | daemon 里定义一个很小的 `SpeechEngine` 接口：开始、送音频、结束拿文字、取消 | G4：云端和本地两种实现已经确定都要做，不是想象中的扩展 | 不定接口，先把百炼写死：App 阶段要回头拆，浏览器协议也可能跟着变 |
| 浏览器 ↔ daemon 协议 | 自定义的极简协议：`start`、二进制 PCM、`finish`、`cancel`；回 `started`、`completed`、`error` | 和引擎无关；不显示中间结果，所以不需要 `result` 事件 | 把百炼的 `run-task` 协议原样透传给浏览器：浏览器就绑死在百炼上 |
| 音频格式 | 浏览器端用 AudioWorklet 转成 16kHz 单声道 16 位 PCM，每 100ms 一块（3200 字节） | 百炼只收 16kHz；PCM 不用编解码，本地引擎也直接能用；ZCode 同样做法 | MediaRecorder 录 webm/opus：只能录完才拿到数据，不能边说边传 |
| 录音开始前的音频 | 浏览器先缓存，收到 `started` 再发 | 用户点下就开始说，建连期间的音频不能丢；缓存只放一处，daemon 简单 | daemon 缓存：要处理浏览器连接还没建好的情况，两头都要缓存 |
| WebSocket 升级入口 | daemon 现在只有终端一个 WebSocket 传输（`createTerminalWebSocketTransport`），改成按路径分发：终端和语音各自处理自己的路径和检查 | 不改 `node-listen.ts` 的接口形状，只多一个小的分发器 | 语音塞进终端的传输里：职责混在一起 |
| 鉴权 | 照终端：子协议 `ohbaby.voice.v1` + `ohbaby.bearer.<base64url(token)>`，并做同样的 Host、Origin、仅本机回环检查 | 复用现成、已测试过的做法 | 地址里带 token：会进日志 |
| 配置 | `config/audio/` 照 `config/tools/search/` 的结构：schema、加载、写入、原子写两个文件、失败一起回滚 | 一致性就是可读性；密钥冲突检查直接复用 | 塞进 `model.json`：语音不是对话模型 |

## 3. Module Structure & File Layout

新增和改动的文件（路径相对仓库根）。

### 3.1 ohbaby-sdk

| 文件 | 内容 |
|---|---|
| `packages/ohbaby-sdk/src/contract/voice.ts`（新增） | 协议常量 `VOICE_PROTOCOL = "ohbaby.voice.v1"`、路径、消息类型、错误码、关闭码 |
| `packages/ohbaby-sdk/src/contract/settings.ts` | 新增 `UiSettingsAudio`、`UiSettingsAudioUpdate`、`UiSettingsAudioResponse` |
| `packages/ohbaby-sdk/src/contract/events.ts` | `UiSettingsChangedEvent` 的 `domains` 新增 `"audio"`（server 的 `SettingsDomain` 类型由它推出） |

### 3.2 ohbaby-agent

| 文件 | 内容 |
|---|---|
| `packages/ohbaby-agent/src/config/audio/types.ts` | `audio.json` 的 zod schema |
| `packages/ohbaby-agent/src/config/audio/loaders.ts` | `getAudioJsonPath()`、加载 |
| `packages/ohbaby-agent/src/config/audio/writer.ts` | `readAudioSettings()`、`updateAudioSettings()`：写 `audio.json` 和 `.env` |
| `packages/ohbaby-agent/src/config/secrets/references.ts` | `collectCredentialReferences` 加上 audio 配置里的 `apiKeyEnv`；模型、搜索两个写入方的调用同步改 |

### 3.3 ohbaby-server

| 文件 | 内容 |
|---|---|
| `packages/ohbaby-server/src/voice/engine.ts`（新增） | `SpeechEngine`、`SpeechTask` 接口 |
| `packages/ohbaby-server/src/voice/dashscope-engine.ts`（新增） | 用 `ws` 客户端连百炼，实现 `run-task` / `finish-task` 流程 |
| `packages/ohbaby-server/src/voice/session.ts`（新增） | 一次录音会话：把浏览器消息转成引擎调用，管超时和清理 |
| `packages/ohbaby-server/src/protocols/web/routes/voice.ts`（新增） | 语音 WebSocket 传输：路径匹配、检查、鉴权、建会话 |
| `packages/ohbaby-server/src/transport/`（新增一个分发器） | 按路径把升级请求交给终端或语音 |
| `packages/ohbaby-server/src/runtime/daemon/server.ts` | 把两个传输交给分发器 |
| `packages/ohbaby-server/src/protocols/web/routes/global-settings.ts` | `GET/PUT /v1/settings/audio` |

`ws` 已经是 ohbaby-server 的依赖（8.22.1），客户端也用它，不加新依赖。

### 3.4 ohbaby-web

| 文件 | 内容 |
|---|---|
| `apps/ohbaby-web/src/api/daemon/voice.ts`（新增） | 建立语音 WebSocket，照 `api/daemon/terminals.ts` |
| `apps/ohbaby-web/src/api/daemon/settings-client.ts` | `getAudio`、`updateAudio` |
| `apps/ohbaby-web/src/runtime/settings-layer.ts`、`src/store/settings-cache.ts` | 新增 `audio` 资源 |
| `apps/ohbaby-web/src/ui/composer/voice/`（新增目录） | `useVoiceInput.ts`（状态机）、`pcm-worklet.ts`（AudioWorklet 处理器）、`VoiceButton.tsx`、`VoiceWaveform.tsx` |
| `apps/ohbaby-web/src/ui/composer/ComposerControls.tsx` | 放麦克风按钮和波形 |
| `apps/ohbaby-web/src/ui/settings/AudioSection.tsx`、`audio-form.ts`（新增）、`sections.ts` | Audio 设置分区 |
| `apps/ohbaby-web/src/ui/shell/AppController.tsx`、`session/SessionScreen.tsx` | 现在只有 `pushError`（固定推 error 类通知），新增推 info 类通知的方法，传到 `Composer`；再传一个"打开 Audio 设置"的回调 |
| `docs/ohbaby-web/redesign-2026-10/` | 代码完成后同步，见 README"实施约定" |

### 3.5 App 阶段（本轮不建）

| 位置 | 内容 |
|---|---|
| `packages/ohbaby-server/src/voice/local-engine.ts` | 本地 Qwen3-ASR 引擎，实现同一个 `SpeechEngine` |
| `~/.ohbaby/models/asr/…`、`~/.ohbaby/models/vad/silero/` | 模型权重，由 App 下载 |

## 4. Architectural Constraints & Trade-offs

| 约束 | 说明 |
|---|---|
| 只在本机回环地址可用 | 和终端一样，daemon 绑定非回环地址时拒绝语音连接。浏览器的麦克风本来也只在安全上下文（`localhost` 或 HTTPS）可用 |
| 一次录音一个连接 | 每次点麦克风建一条新连接，识别完就关。不做连接复用，省掉状态同步 |
| 不显示中间结果 | 协议里没有中间结果事件。以后要做，再加一个可选事件，老前端忽略即可 |
| 本地识别会阻塞 | sherpa-onnx 的识别是同步计算，App 阶段要放进 worker 线程或子进程，不能放在 daemon 主线程。接口按异步设计，提前留好 |

| 取舍 | 得到 | 付出 |
|---|---|---|
| 经 daemon 中转 | key 安全、引擎可换 | daemon 多一个模块，多一跳（本机，可忽略） |
| 自定义浏览器协议 | 前端不绑定百炼 | 要写一层转换（`session.ts`） |
| 浏览器缓存开头的音频 | daemon 简单 | 浏览器要多一个队列，大小由开始超时限住（见 non-functional §2.1） |
