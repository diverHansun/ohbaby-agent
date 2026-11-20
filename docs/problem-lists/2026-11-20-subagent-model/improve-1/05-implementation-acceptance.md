# 5. 实施与验收

2026-11-20，Stage 1、2 在本地 `codex/subagent-model` 完成。Web 和 TUI 的界面与交互由用户在同一分支实施。

## 后端行为

- 用户可以从配置完整的条目中任选一个作为子代理模型，也可以选择跟随聊天。可选的思考档位随模型选择保存，省略时使用该条目的默认值。
- 新建子代理，或给空闲子代理发消息时，读取当时的设置。模型、档位和运行配置取自同一份模型库快照。已取得配置的执行继续使用这个快照。删除条目后发起的新执行跟随父会话。
- 若模型条目缺少连接配置，或已有父会话运行时模型库暂时读不出来，子代理使用父会话这一轮的模型和档位并发出提示。已选模型实际请求的鉴权错误照常报告。显式档位失效时，本次执行使用所选模型的默认档位。

## 前端接口

| 入口 | 调用 |
| --- | --- |
| Web Settings | `runtime.settings.selectSubagentModel({ id, reasoning? })`。沿用 Settings 写入队列及缓存 |
| TUI | `client.selectSubagentModel({ entryId, reasoning? })` |
| `/models` 数据 | `subagent` 顶层设置包含模型名、档位及 `configurationComplete`。`models` 中每行的 `subagent` 标明是否为所选模型 |

`id` 或 `entryId` 传 `null` 恢复跟随聊天。选 `Model default` 时省略 `reasoning`。HTTP 和 TUI 命令读取同一个全局设置。前端的 Default 说明、模型与档位选择、删除提示和真实界面走查对应 T14 至 T20。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| T1–T6 | 模型库读写、后台探测、单条和按提供商删除、HTTP 校验、JSON-RPC 转发及 `/models` 数据通过 |
| T7–T13、T11a、T12a | 通过。覆盖独立模型与档位、父会话继承、运行中保持原模型、空闲后跨协议续跑、设置读取失败、档位失效和并发删除 |
| 回归 | 单元测试 5,495 项通过，契约测试 591 项通过。最终版本的 250 个非 CLI 集成测试文件共 2,523 项通过，12 项按测试条件跳过。CLI 打包、安装和启动相关测试另行运行 |
| 真实请求 | 两次通过。父会话用阿里云 `qwen3.8-flash`，子代理用智谱 `glm-5.3-flash`，两端均返回完成。记录的实际模型请求符合配置。DeepSeek 直连超时后改用上述两个端点 |
| 静态检查 | `pnpm typecheck`、`pnpm lint` 及改动代码的格式检查通过。全库格式检查发现基线 `packages/ohbaby-server/src/terminal/pty.integration.test.ts` 的已有格式问题 |

本次真实请求通过临时模型库执行，使用本地 `.env` 中的凭证。测试目录已清理。
