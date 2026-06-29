# 实施方案与修改 / 影响点

> 前置：先读 [01-problem-analysis.md](./01-problem-analysis.md)。
> 一句话目标：**`apiKeyEnv` 与 `apiKey` 全链路改为可选；无 key 时后端合成非空占位符满足
> SDK 约束；"密钥对不对"交由上游请求验证。** 不引入任何地址探测启发式。

## 一、设计原则

1. **后端是唯一权威**：是否需要 key、缺省时如何兜底，只在后端决定；前端只负责采集与透传。
2. **前端不做权威校验**：三端去掉对 `apiKeyEnv` / `apiKey` 的必填断言（保留格式/正整数等无关校验）。
3. **占位符只在最后一刻合成**：仅当确无可用密钥时，后端用一个非空占位符喂给 SDK / probe；
   占位符**不写入 `.env`**、**不冒充真实密钥**。
4. **向后兼容**：已配置 key 的云端用户行为不变；既有 `model.json` 不迁移。
5. **校验收敛单点**：删除散落的必填校验，不要在传播路径上顺手补新校验（守住 DRY / KISS）。

## 二、已采用决策

| # | 决策 | 候选 | 倾向 | 影响文件 |
|---|---|---|---|---|
| D1 | 无 key 占位符取值 | `"not-needed"` / `"local"` / `"sk-noop"` | **`"not-needed"`**（语义清晰、非空、非密钥样式） | `apply-active-model-config.ts`、`manager.ts` |
| D2 | 填了 `apiKey` 值但没填 `apiKeyEnv` 名时，密钥写哪 | ① 缺省名 `<PROVIDER>_API_KEY`；② 该情形下条件性要求 apiKeyEnv | **①缺省名**（保持"零必填"，与"取消强制"一致） | `writer.ts`、`apply-active-model-config.ts` |
| D3 | 结果契约 `UiConnectModelResult.apiKeyEnv` / `UiCurrentModelConfig.apiKeyEnv` 无 key 时返回 | 省略字段（可选）/ 空串 | **省略字段**（类型改 `apiKeyEnv?: string`，UI 处理 undefined） | `connect-model.ts`、`activeModel.ts`、`App.tsx`、`connect-panel.tsx` |
| D4 | 显式配置 env 名但取不到值时的诊断 | 硬失败 / 静默占位 / 非阻断 warning | **非阻断 warning**：继续用占位符，让上游决定是否鉴权；CLI/Web 展示 warning | `apply-active-model-config.ts`、`App.tsx`、`connect-panel.tsx` |

> 下文按最终方案（D1=`"not-needed"`、D2=缺省名、D3=省略字段、D4=非阻断 warning）展开。

## 三、阶段划分（每阶段可独立编译 + 测试）

- **阶段 A（后端地基，核心）**：放开 `resolveApiKey` 兜底、放开加载校验、占位符注入。
  完成后即可让本机 LM Studio "连得上 + 用得了"（哪怕前端还没改，可用 CLI 命令或直接写 model.json 验证）。
- **阶段 B（类型/契约放开）**：`apiKeyEnv` 由必填改可选，逐层传播。
- **阶段 C（前端三端）**：去掉必填断言 + 文案标注 optional。
- **阶段 D（文档/示例）**：README、`.env.example`、`/connect` 帮助文案补充"本机无需 key"。

## 四、逐文件修改点

### 阶段 A — 后端

| 文件 | 位置 | 修改 |
|---|---|---|
| `config/llm/apply-active-model-config.ts` | `resolveApiKey` 285-303 | 改为：显式值 → 环境变量 → **占位符 `"not-needed"`**（不再抛 `MISSING_API_KEY`）。返回值同时带出"是否为占位符"标记，供持久化决策（见下）。 |
| 同上 | `applyActiveModelConfig` 102-193 | `provider` 仍必填；`apiKeyEnv` 改可选。`setActiveLLMConfig` 调用：仅当**有真实密钥值**时才传 `apiKey` 写 `.env`；占位符不写盘。`apiKeyEnv` 缺省时按 D2 生成 `<PROVIDER>_API_KEY` 仅用于"有值无名"场景。 |
| `config/llm/manager.ts` | `performLoad` 169-179 | 去掉无条件 API key 存在校验：无密钥值时不抛，构建 `LLMConfig` 时 `apiKey` 用占位符 `"not-needed"`。`apiKeyEnv` 缺省时不报错。进程 env 为空时可回落到 `.env` 的非空值。 |
| `config/llm/validation.ts` | `validateModelJson` 190；原 `validateApiKey` 268-287 | `apiConfig.apiKeyEnv` 由必填改可选；LLM 侧原 `validateApiKey` 删除，避免保留无人调用的强制 key API。 |
| `config/llm/writer.ts` | 158-188 | `apiKeyEnv` 可选；`buildModelJson`（140-156）在 `apiKeyEnv` 缺省时省略 `apiConfig.apiKeyEnv` 字段；写 `.env` 条件不变（仅有真实值才写）。 |
| `config/llm/context-window-probe.ts` | 37-45 | 无需逻辑改动——保证传入的是非空占位符即可（由 `applyActiveModelConfig`/`probeActiveModelContextWindow` 保证）。 |

> 占位符常量建议集中定义一处（如 `config/llm/` 下），避免散落。`"not-needed"` 字面量只此一份。

### 阶段 B — 类型 / 契约（`string` → `string?`）

| 文件 | 位置 |
|---|---|
| `packages/ohbaby-sdk/src/connect-model.ts` | 7（`UiConnectModelInput.apiKeyEnv`）、18（`UiConnectModelResult`）、33（`UiCurrentModelConfig`）、43（`UiProbeModelContextWindowInput`）→ 可选 |
| `apps/ohbaby-web/src/api/daemon/wire.ts` | 106（`ModelConnectRequest.apiKeyEnv`）→ 可选 |
| `config/llm/apply-active-model-config.ts` | 23、37、52、287 → 可选 |
| `config/llm/writer.ts` | 18、36 → 可选 |
| `config/llm/types.ts` | 24、81 → 可选 |
| `core/llm-client/types.ts` | 104 → 可选 |
| `commands/types.ts` | 69 → 可选 |
| `services/llm-model/activeModel.ts` | 13 → 可选（`summarizeActiveModel` 输出处理 undefined） |

> 这些大多是机械传播。**护栏**：不要趁机在每个传递点加"规范化/校验"——校验只在阶段 A 后端一处。

### 阶段 C — 前端三端

| 文件 | 位置 | 修改 |
|---|---|---|
| `commands/connect.ts` | `required` 90-105 | 从 `required` 移除 `["apiKeyEnv", "--api-key-env"]`；解析仍接受该 flag（可选）。保留第 48-55 行禁止 `--api-key` 明文入参。 |
| `connect-panel.tsx` | `buildPayload` 398-408 | 移除 `!apiKeyEnv` 必填条件；`CONNECT_FIELDS`（51-59）给 `apiKeyEnv` 标 `optional`。 |
| `App.tsx`（Web） | `connectModelRequest` 1990-2013（第 1993 行） | `apiKeyEnv` 改 `trimmedOrUndefined`；TextField（1632-1647）标 optional + 提示文案。 |
| `create-app.ts`（Server） | `modelConnectInputFromBody` 301-332（306、314） | `apiKeyEnv` 缺失不再使 input 无效；其余必填（provider/baseUrl/model）保留。 |

### 阶段 D — 文档 / 示例

| 文件 | 修改 |
|---|---|
| `.env.example` | 补注释：本机/无鉴权服务（LM Studio 等）无需任何 key。 |
| `README.md` / `README.zh.md` | `/connect` 段补"本机推理服务可只填 provider/baseUrl/model"。 |
| `/connect` 帮助文案 | 标注 api key 相关参数为可选。 |

## 五、影响面与回归风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 加载校验放开导致云端"忘填 key 也不报错" | 行为从"启动即报错"变为"请求时 401" | D4 非阻断 warning 区分"显式配置 env 但取不到值"与"纯 keyless"；验收用例覆盖"远程无 key → 清晰 401"。 |
| 占位符被误当真实 key 写盘 | 破坏 `.env` 收敛范式 | 阶段 A 明确：占位符**绝不写 `.env`**，仅运行时注入。 |
| 类型放开波及面广（~14 文件） | 编译错误连锁 | 分阶段；阶段 B 单独提交，确保 `tsc` 全绿。 |
| 结果契约 `apiKeyEnv` 变可选破坏 UI 展示 | `getCurrentModel` / status 行 | UI 对 undefined 兜底显示（如 "—"）。 |
| probe 带空 header 被某些服务拒绝 | 远程无 key 时 | 占位符保证非空；probe 失败已优雅回退默认 context window。 |

## 六、反教条护栏（针对本次改动）

- **不要**引入 `isLocalBaseUrl` / LAN 探测——本方案明确放弃地址启发式，保持零魔法。
- **不要**在阶段 B 的类型传播途中顺手加校验/默认值；校验单点在后端阶段 A。
- **不要**把占位符写进 `.env` 或 `model.json` 的密钥字段——它只活在内存/请求头。
- **不要**改动 `inferConnectModelInterfaceProvider` 与 `--api-key` 明文禁用（与本需求无关，且后者是安全护栏）。
