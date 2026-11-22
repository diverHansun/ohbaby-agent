# 前端 05：组件

## 1. 分层与命名

沿用现有目录：输入框相关的放 `ui/composer/`，设置相关的放 `ui/settings/`，和 daemon 通信的放 `api/daemon/`。语音输入的几个文件放进新的子目录 `ui/composer/voice/`，因为它们只给输入框用，而且自成一组。

| 层 | 文件 | 职责 |
|---|---|---|
| 通信 | `api/daemon/voice.ts` | 建立语音 WebSocket，收发协议消息。不碰麦克风和界面 |
| 音频 | `ui/composer/voice/pcm-worklet.ts` | AudioWorklet 处理器：降采样到 16kHz、转 16 位整数、每 100ms 交出一块、算音量 |
| 状态 | `ui/composer/voice/useVoiceInput.ts` | 04 §1 的状态机；串起麦克风、worklet、通信；结束时清理 |
| 显示 | `ui/composer/voice/VoiceButton.tsx`、`VoiceWaveform.tsx` | 只按状态显示，不自己管状态 |
| 设置 | `ui/settings/AudioSection.tsx`、`audio-form.ts` | 照 `SearchSection.tsx`、`search-form.ts` |

## 2. 组件索引

| 组件 / 模块 | 新增或改动 | 用在哪 |
|---|---|---|
| `useVoiceInput` | 新增 | `Composer` |
| `VoiceButton` | 新增 | `ComposerControls`，发送按钮左边 |
| `VoiceWaveform` | 新增 | `ComposerControls`，`ohb-composer-bar-spacer` 里 |
| `openVoiceConnection`（`api/daemon/voice.ts`） | 新增 | `useVoiceInput` |
| `AudioSection` | 新增 | `SettingsDialog`，`sections.ts` 里加 `"audio"` |
| `ComposerControls` | 改动 | 新增 `voice` 参数，放按钮和波形；录音时发送按钮不可用 |
| `Composer` | 改动 | 调 `useVoiceInput`；Esc 优先级（04 §3）；插入文字（04 §4） |
| `settings-client.ts`、`settings-layer.ts`、`settings-cache.ts` | 改动 | 新增 `audio` 资源 |
| `AppController`、`SessionScreen` | 改动 | 新增推 info 类通知的方法和"打开 Audio 设置"的回调，传给 `Composer` |

## 3. 关键组件契约

### 3.1 `useVoiceInput`

**Purpose**：管理一次录音从开始到插入文字的全过程。

**API**：

```ts
function useVoiceInput(input: {
  readonly connect: () => VoiceConnection; // 来自 api/daemon/voice.ts
  readonly configured: boolean | undefined; // undefined = 还没读到配置
  readonly onText: (text: string) => void; // 插入文字，由 Composer 实现 04 §4
  readonly onNeedsSetup: () => void; // 打开设置的 Audio 分区
  readonly onNotice: (notice: { kind: "error" | "info"; message: string }) => void;
}): {
  readonly state: "unavailable" | "idle" | "requesting" | "recording" | "transcribing";
  readonly levels: readonly number[]; // 最近的音量，0–1，给波形用
  readonly toggle: () => void; // 点按钮：idle 时开始，requesting/recording 时停止
  readonly cancel: () => void; // Esc、切会话
};
```

**规则**：

- 组件卸载时自动 `cancel`。
- 切会话时由 `Composer` 调 `cancel`（会话 ID 变化时）。
- 音量换算：每块 PCM 算均方根，换成分贝后把 -50dB 到 -10dB 线性映射到 0–1，低于 -50dB 记 0，高于 -10dB 记 1。
- `levels` 只保留波形画得下的个数（按最大宽度算），不随录音时长增长。
- 所有出错路径都调用 `onNotice`，文案按 04 §5；`not_configured` 额外调用 `onNeedsSetup`。

### 3.2 `VoiceButton`

**Purpose**：开始、停止录音的按钮，同时表现当前状态。

**Use when**：主输入框底部一行。**Do not use when**：侧边对话、编辑历史消息等其他输入框（本轮不做）。

**Anatomy**：一个图标按钮，大小和底部一行其他图标按钮相同。

**States**：

| 状态 | 图标 | `aria-label` / `title` | 可点 |
|---|---|---|---|
| `unavailable` | `Mic` | `Voice input needs localhost or HTTPS` | 否 |
| `idle`，已配置或未知 | `Mic` | `Voice input` | 是 |
| `idle`，未配置 | `Mic` | `Set up voice input` | 是（打开设置） |
| `requesting`、`recording` | `Square`（实心，主文字色，没有底色） | `Stop recording (Esc to cancel)` | 是 |
| `transcribing` | `LoaderCircle`（转圈） | `Transcribing…` | 否 |

**API**：`{ state, configured, onClick }`。

**Accessibility**：`recording` 时 `aria-pressed="true"`；`transcribing` 时 `aria-busy="true"`。状态变化时有一个读屏可读的提示（`aria-live="polite"` 的隐藏文字）：`Recording`、`Transcribing`、`Inserted`。

### 3.3 `VoiceWaveform`

**Purpose**：录音时显示音量变化，让用户知道"它在听"。

**Anatomy**：一排细竖条，最新的在最右边，从右往左滚动。宽度 120–160px，容器窄时缩小，最小约 48px，竖条数跟着宽度变。

**States**：`recording` 时显示波形；`transcribing` 时换成 `Transcribing…` 文字；其他状态不渲染。

**API**：`{ state, levels }`。

**实现提示**：用一个 `<canvas>` 或一组 `<div>` 都可以，按每秒至少 20 帧刷新。`prefers-reduced-motion` 时不滚动，只让竖条高度跟着音量变。

**Accessibility**：`aria-hidden="true"`，录音状态由 `VoiceButton` 的读屏提示说明。

### 3.4 `openVoiceConnection`（`api/daemon/voice.ts`）

照 `api/daemon/terminals.ts` 的 `new WebSocket(url, [TERMINAL_PROTOCOL, encodeTokenProtocol(token)])` 写法：

```ts
interface VoiceConnection {
  sendAudio(chunk: ArrayBuffer): void;
  finish(): void;
  cancel(): void;
  onStarted(listener: () => void): void;
  onCompleted(listener: (text: string) => void): void;
  onError(listener: (code: VoiceErrorCode | "disconnected", message: string) => void): void;
}
```

具体方法名由实施决定，契约是：连接打开后自动发 `start`；只负责协议（[dfd-interface §3.2](../dfd-interface.md)），不缓存音频（缓存在 `useVoiceInput`），没收到 `completed` 或 `error` 就断开时报 `disconnected`。

### 3.5 `AudioSection`

照 `SearchSection`：`useSettingsResource(settings, "audio", visible)` 读取，表单只提交改过的字段，API key 用现有的 `SecretField`，校验失败按字段标红。字段和顺序见 [03 §4.2](03-ui-layout-and-style.md)。`audio-form.ts` 负责表单值和 `UiSettingsAudioUpdate` 之间的转换和本地校验（Base URL 必须是合法地址；语言提示最多 4 个）。

## 4. Component vs Pattern

| 是组件 | 是模式 |
|---|---|
| `VoiceButton`、`VoiceWaveform`、`AudioSection` | "按钮就地变成停止"：麦克风按钮在录音时换图标，而不是另起一个停止按钮。和现有发送按钮在运行时变成"停止运行"是同一个模式 |
| | "设置分区照 Web search 的版式"：说明行 + 字段 + More options + Save |
