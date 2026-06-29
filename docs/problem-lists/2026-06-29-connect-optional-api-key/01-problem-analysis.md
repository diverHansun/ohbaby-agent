# 现有问题分析：`/connect` 强制要求 API env / API key

> 关联范式：[2026-06-17-api-key-env-centralization](../2026-06-17-api-key-env-centralization/README.md)
> （"配置文件存键名 `apiKeyEnv`、真实值进 `.env`"）。本次改动**不破坏**该范式，只是把
> "键名 + 值"从**强制**降级为**可选**。

## 一、问题现象

本地用 LM Studio / Ollama / vLLM / llama.cpp 这类推理服务时，只需要一个 `baseUrl`
（如 `http://127.0.0.1:1234/v1`）即可推理，**不需要任何 API key**。但当前 `/connect`
全链路（后端 + CLI + Web）都把 `apiKeyEnv`（环境变量名）和 `apiKey`（密钥值）当成
必填/必须存在项，导致用户被迫：

1. 凭空编一个环境变量名（如 `LMSTUDIO_API_KEY`）；
2. 再给它塞一个假值（如 `lm-studio`）写进 `.env`。

这两步对本机/无鉴权推理服务而言是纯粹多余的负担。

## 二、目标澄清（与早先讨论的区别）

- **不是**"识别回环/私网地址就自动免 key"（那是一种隐式启发式，违背"显式胜过隐式"）。
- **而是**：**取消 `apiKeyEnv` 与 `apiKey` 的强制校验**——无论 `baseUrl` 是本机回环、
  私有局域网，还是远程公网地址，两者一律**可选**。
  - 填了就用；没填，后端合成一个**无害占位符**让底层 SDK 满足"非空 key"的硬约束。
  - "这个 key 到底对不对 / 需不需要"由**上游请求**来回答（真需要鉴权时返回 401，
    错误信息清晰）——即"把验证交给后端（实为上游）"。

这样做的好处：没有任何地址探测启发式，偶然复杂度最低，且对所有 provider 一视同仁。

## 三、概念根因

当前代码把"是否需要 API key"建模成了**普适必填**；而真实世界的模型是
**"是否需要 key 取决于具体 endpoint"**——这是一个**条件性**需求，被写成了**无条件**约束。
这属于典型的偶然复杂度：我们自己制造的、本可避免的复杂度。

更细看，代码里其实把**两个不同的东西**捆在了一起，且都强制：

- `apiKeyEnv`：环境变量的**名字**（用于定位/持久化密钥）。
- `apiKey`：密钥的**真实值**。

无 key 场景下，这两者都不应是必填。

## 四、强制点全链路盘点（六层）

| # | 层 | 位置 | 强制了什么 | 性质 |
|---|---|---|---|---|
| 1 | CLI 斜杠命令 | `packages/ohbaby-agent/src/commands/connect.ts:90-105` | `--api-key-env` 在 `required` 列表 | 名字必填 |
| 2 | CLI ConnectPanel | `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx:398-408`（`buildPayload`） | `apiKeyEnv` 非空才允许保存 | 名字必填 |
| 3 | Web 表单 | `apps/ohbaby-web/src/ui/App.tsx:1990-2013`（`connectModelRequest`），第 1993 行 `requiredText(form.apiKeyEnv, ...)` | `apiKeyEnv` 必填 | 名字必填 |
| 4 | Web 服务端路由 | `packages/ohbaby-server/src/app/create-app.ts:301-332`（`modelConnectInputFromBody`），第 306/314 行 | `apiKeyEnv` 缺失 → 返回 400 | 名字必填 |
| 5 | 后端 connect 执行 | `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts:285-303`（`resolveApiKey`） | 找不到密钥**值**就抛 `MISSING_API_KEY` | **值必须存在** |
| 6 | **运行时加载配置** | `packages/ohbaby-agent/src/config/llm/manager.ts:179` → `validateApiKey`（`config/llm/validation.ts:268-287`）；以及 `validation.ts:190` 要求 `apiConfig.apiKeyEnv` | 每次 load 校验密钥值非空 + 要求 apiKeyEnv 键名存在 | **值 + 名字必须存在** |

第 1–4 层强制的是**名字**，第 5–6 层强制的是**真实值**。

### 4.1 最致命、也最容易漏的一层：第 6 层（运行时加载）

用户只感知到 `/connect` 报错，但**真正的重心是第 6 层**：

- 即使 connect 流程被放开、成功写入 `model.json`，**下一次** `LLMConfigManager.performLoad`
  仍会无条件执行 `validateApiKey`（`manager.ts:179`），密钥值缺失即抛
  `MISSING_API_KEY` / `EMPTY_API_KEY`（`validation.ts:268-287`），导致**整个 runtime 起不来**。
- 同时 `validateModelJson`（`validation.ts:156-262`）在第 190 行要求 `apiConfig.apiKeyEnv`
  必须存在，否则在 load / 写盘前就抛 `MISSING_FIELD`。

结论：**只放开前端和 connect 执行还不够**，必须同步放开第 6 层的加载校验，否则"连得上、用不了"。

### 4.2 底层 SDK 的"非空 key"硬约束（唯一物理必需点）

最终送进 provider SDK：

- OpenAI 兼容：`packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts:148-152`
  —— `new OpenAI({ apiKey, baseURL })`。OpenAI Node SDK 在 `apiKey` 为空/假值时**会抛错**，
  必须是**非空字符串**（但不校验内容）。
- Anthropic 兼容：`packages/ohbaby-agent/src/services/interface-providers/anthropic.ts:378-384`
  —— `new Anthropic({ apiKey, baseURL })`，同理需要可解析的认证值。

也就是说：**底层只要求"非空"，不在乎"是什么"**。这正是"后端在无 key 时合成占位符"
方案成立的依据——满足 SDK 的物理约束，又不强迫用户提供真实密钥。

### 4.3 context window 探测（probe）

`packages/ohbaby-agent/src/config/llm/context-window-probe.ts:37-45` 会带
`Authorization: Bearer <apiKey>` 或 `x-api-key: <apiKey>` 去 GET `/v1/models`：

- 本机服务：用占位符也能成功拿到 `context_length`，体验良好。
- 远程无 key：probe 失败时已有**优雅回退**——`probeContextWindow` 捕获异常返回
  `warning` 并回退默认值（`apply-active-model-config.ts:195-226`、`context-window-probe.ts:62-78`），
  **不会中断 connect**。所以 probe 这条路本身无需特别改造，只要保证它收到的是非空占位符即可。

## 五、后端详析

### 5.1 connect 执行路径

`/connect` → SDK 契约 `connectModel` → daemon JSON-RPC → backend
`adapters/ui-inprocess.ts:1331-1371`（`connectModelInternal`）→
`config/llm/apply-active-model-config.ts:102-193`（`applyActiveModelConfig`）。

`applyActiveModelConfig` 内部：
1. `resolveApiKey`（第 285-303 行）**强制要求密钥值存在**，否则抛 `MISSING_API_KEY`——
   这是 connect 阶段的拦路点。
2. `probeContextWindow` 用该 key 探测；
3. `setActiveLLMConfig`（`config/llm/writer.ts:158-188`）写 `model.json`，
   并在 `apiKey !== undefined && envPath !== undefined` 时把密钥写进 `.env`（第 174-176 行）。

### 5.2 加载路径（见 4.1）

`config/llm/manager.ts:153-227`（`performLoad`）每次构建 `LLMConfig` 都会
`validateApiKey`（第 179 行）。这是 connect 之外、运行时复发的强制点。

### 5.3 持久化的耦合点

`writer.ts` 仅当 `apiKey` 值存在时才写 `.env`，写入位置由 `apiKeyEnv` 决定（键名作为
`.env` 的 KEY）。**因此一旦允许"有值无名"，就需要回答：密钥值写到 `.env` 的哪个 KEY 下？**
（详见实施方案中的待确认决策。）

## 六、前端详析

### 6.1 CLI 斜杠命令 `/connect`

`commands/connect.ts:90-105`：`required` 数组含 `["apiKeyEnv", "--api-key-env"]`，
缺失即返回 `MISSING_ARGS`。需把 `apiKeyEnv` 移出 `required`（保留为可选解析）。

注意：第 48-55 行已禁止 `--api-key` 明文入参（安全设计，**保留**）。

### 6.2 CLI ConnectPanel（TUI）

`connect-panel.tsx`：
- 字段定义 `CONNECT_FIELDS`（第 51-59 行）已把 `apiKey` 标 `secret`，但
  `apiKeyEnv` 仍是普通必填。
- `buildPayload`（第 398-408 行）：`if (!provider || !baseUrl || !apiKeyEnv || !model) return { kind: "incomplete" }`
  —— 需移除 `!apiKeyEnv` 条件。
- 自动保存（`maybeSave`）以 payload 是否 `incomplete` 为触发条件，逻辑无需大改，
  仅依赖 `buildPayload` 的必填集合收敛。

### 6.3 Web 表单（ConnectModelOverlayBody）

`apps/ohbaby-web/src/ui/App.tsx`：
- 表单状态 `ConnectModelFormState`（第 1487-1495 行）。
- `connectModelRequest`（第 1990-2013 行）第 1993 行
  `const apiKeyEnv = requiredText(form.apiKeyEnv, "API key env")` —— 需改为可选
  （`trimmedOrUndefined`）。
- UI 文案：第 1632-1647 行 "API key env" / "API key" 字段应标注 "optional"，
  并补充"本机/无鉴权服务可留空"的提示。

### 6.4 Web 服务端路由

`packages/ohbaby-server/src/app/create-app.ts`：
- `modelConnectInputFromBody`（第 301-332 行）第 306、314 行把 `apiKeyEnv` 当必填，
  缺失则整个 input 返回 `undefined` → 路由 400（第 996-1001、1031-1036 行）。
- 需把 `apiKeyEnv` 从"缺失即 invalid"中移除。
- `interfaceProvider` 仍由 `inferConnectModelInterfaceProvider(baseUrl)` 推断（第 325 行），
  与本次改动无关，保持不变。

## 七、类型与契约层

`apiKeyEnv: string`（必填）当前分布（已扫描，非测试、非 dist）：

- SDK：`packages/ohbaby-sdk/src/connect-model.ts:7,18,33,43`（`UiConnectModelInput`、
  `UiConnectModelResult`、`UiCurrentModelConfig`、`UiProbeModelContextWindowInput`）。
- Web wire：`apps/ohbaby-web/src/api/daemon/wire.ts:106`（`ModelConnectRequest`）。
- 后端：`config/llm/apply-active-model-config.ts:23,37,52,287`、`config/llm/writer.ts:18,36`、
  `config/llm/types.ts:24,81`、`core/llm-client/types.ts:104`、`commands/types.ts:69`、
  `services/llm-model/activeModel.ts:13`。
- 前端：`connect-panel.tsx:32`、`App.tsx:1489`。

> 多数是**纯类型传播**，需要从 `string` 改为可选 `string?`（或在 `Result`/`CurrentModelConfig`
> 上保留为可选）。**注意区分"输入契约"与"结果/持久化契约"**：输入侧 `apiKeyEnv` 改可选；
> 结果侧（如 `UiConnectModelResult.apiKeyEnv`）在无 key 时应返回什么（空串 / 省略 / 占位符名），
> 需在实施方案中统一。

## 八、与既有设计的关系（不破坏）

- "配置存键名、真实值进 `.env`、统一收敛到全局 `~/.ohbaby-agent/.env`"的范式
  （见关联文档）**完全保留**。本次只是允许"键名与值同时缺省"。
- 既有云端用户（已配 `apiKeyEnv` + `.env` 值）的行为**完全不变**——"可选"是"必填"的超集。
- 既有 `model.json`（含 `apiKeyEnv`）**仍然合法**，无需数据迁移。

## 九、遗留问题 / 待确认（详见实施方案）

1. **占位符取值**：无 key 时后端合成的字符串用什么？（建议 `"not-needed"`，非空、非密钥、可读。）
2. **"有值无名"如何持久化**：用户填了 `apiKey` 值但没填 `apiKeyEnv` 名，密钥写到 `.env` 的哪个 KEY？
   （候选：① 缺省名 `<PROVIDER>_API_KEY`；② 仅此情形下条件性要求 `apiKeyEnv`。）
3. **结果契约**：`UiConnectModelResult` / `UiCurrentModelConfig` 在无 key 时 `apiKeyEnv` 返回值。
4. **软提示（可选）**：远程地址 + 无 key 时，是否给非阻塞提示"若供应商需要鉴权将失败"。
   （不阻断保存，仅提升体验。）
