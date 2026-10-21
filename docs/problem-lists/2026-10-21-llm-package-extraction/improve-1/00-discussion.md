# 讨论记录与已确认要点

> 2026-10-21 与用户讨论定稿。方案见 [02](02-optimization-plan-and-change-scope.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)。

## 1. 背景与动机

用户在审视包划分时提出：`ohbaby-agent` 里的 LLM 客户端是可以复用的部分，应该单独成包。调研 code-cli 下的项目后发现，pi、opencode、claude-code、dsh 都有一个不依赖 agent 核心的 LLM 包（详见 [03](03-reference-projects.md)）。

用户确认把这件事和 sdk、server 的结构整理分成两个议题，本议题在后者之后实施。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 包名 | `ohbaby-llm`，放在 `packages/ohbaby-llm` |
| 收纳范围 | `core/llm-client/`、`services/interface-providers/`，以及 `config/llm` 中的纯部分 |
| `config/llm` 归属 | 纯类型（`types.ts`）、纯校验（`validation.ts`）、纯函数（`model-profile.ts`）进 `ohbaby-llm`。读文件、读环境变量、写配置、网络探测的部分留在 agent 的 `config/llm` |
| `createLLMClient` | `ohbaby-llm` 提供一个直接接收已解析 `LLMConfig` 的构造函数，不再自己读配置单例。agent 保留原名、原签名的 `createLLMClient`，负责读配置后调用它 |
| 日志 | `ohbaby-llm` 不依赖日志系统。token 用量规范化的诊断事件由调用方通过回调接收，agent 在回调里写日志 |
| `reasoningCapabilityView` | 它把推理能力投影成 sdk 的 UI 类型，属于适配逻辑，留在 agent，放到 `services/llm-model/` |
| `ohbaby-llm` 的依赖 | 只依赖 `openai`、`@anthropic-ai/sdk`、`zod`，不依赖任何 workspace 包 |
| 抽出后 agent 的用法 | agent 内部全部改为从 `ohbaby-llm` 引入，不在 agent 里留一份副本 |
| agent 的公开导出 | 原来通过 `ohbaby-agent` 导出的 LLM 相关名字继续导出，避免影响下游 |
| 是否发布 | 公开发布到 npm，版本号与其他包同步。发布顺序变为 sdk、llm、agent、server、cli |
| 关键改动清单 | 用户要求在 02 中列出 |
| 实施时间 | sdk 与 server 结构整理完成之后 |

讨论中用户直接拍板的是：两个议题分开实施、抽包方向、`config/llm` 纯部分进包、`reasoningCapabilityView` 留在 agent。日志改用回调、agent 公开导出保持不变、公开发布这三项，是规划时根据上述决定推导出来的，随本文档一起提交用户审查确认。

## 3. 已确认：边界（不做的事）

| 项 | 处理 |
|---|---|
| `services/llm-model/`（模型档案、token 预算、启发式计数） | 留在 agent。它依赖配置，且和 LLM 调用代码之间没有互相引用 |
| 读写 `model.json`、`.env`，上下文窗口和推理能力的网络探测 | 留在 agent |
| 全局代理（`utils/network-proxy`） | 留在 agent。它通过 undici 全局 dispatcher 生效，LLM 代码本来就不感知 |
| 改变 LLM 调用行为、重试策略、缓存键 | 不做，本轮只搬代码、解耦合 |
| 新增 provider，或引入统一的中间表示 | 不做 |
| 把 provider 适配器再拆成独立的包（像 dsh 那样） | 不做，目前只有三种协议 |

## 4. 已确认：与关联议题的关系

- [sdk 与 server 结构整理](../../2026-10-21-sdk-server-boundaries/README.md)：先实施。两者没有文件交叉。
- [LLM SDK 与 Responses 迁移](../../2026-09-11-llm-sdk-and-responses-migration/README.md)：它冻结的阶段边界（不做统一中间表示、不换协议）本议题同样遵守。
- [interface-providers 改名记录](../../../services/llm-model/improve-1/04-interface-providers-boundary.md)：provider 与 interfaceProvider 的术语沿用。

## 5. 参考项目

pi 的 `pi-ai`、opencode 的 `ai`、claude-code 的 `@ant/model-provider`、dsh 的 `dsh-llm` 都不依赖 agent 核心。kimi-code 的 `kosong` 也是独立的，但核心没有用它，另外维护了一份 `llm-adapter`，这是本议题要避免的情况。详见 [03](03-reference-projects.md)。
