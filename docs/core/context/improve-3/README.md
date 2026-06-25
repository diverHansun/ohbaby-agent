# context improve-3 · 总览

> improve-3 的主题是**偿还 context 模块的结构债，并为路线图能力打好分层地基**——把"上下文生命周期"理顺成四个主链层 + origin 旁路，而非堆叠新功能。
>
> 基调（贯穿五层）：遵循 KISS/YAGNI，**先地基后能力、反过早抽象**。多处刻意推迟（origin taxonomy、压缩插件接口、cutoff 持久化），等真实消费方出现再与之共同设计。

> **规划评审**：2026-06-25 对五层规划做了逐一缺口评审，识别 12 个技术缺口并给出决策。详见 [gaps-and-decisions.md](./gaps-and-decisions.md)。各子主题文档均引用该缺口记录。

---

## 背景与定位

improve-2 已落地 P0：per-step 压缩、overflow recovery、tool metadata 白名单投影、reasoning 不持久化。improve-3 在此之上做**结构理顺 + 两道新防线**，不重复 improve-2 已完成项。

源头输入：
- 2026 上下文管理路线图（reasoning 过滤=已做；2.2 工具清除；2.5 存储/推理分离≈已做；2.4 compress-as-tool；origin 等）。
- 参考项目：kimi-code（量级标尺：projector + micro/full + PromptOrigin）、gemini-cli（重型反面标尺：图+处理器编排，**借思想不引架构**）、claude-code、oh-my-pi（遮罩最精细，借鉴其占位符带原大小 + 小结果不遮）。

---

## 五个子主题与依赖

| 顺序 | 子主题 | 目录 | 本轮做什么 | 关键决策 |
|------|--------|------|-----------|----------|
| 1 | **编排层去三重** | [编排层/](./编排层/) | compress/compact/prepareTurn 三重脊椎收成单一 `runCompaction`；删僵尸 `compress`；prune 统一到内存工作集 | 删 compress、内存工作集+commit-once、接受分支重读一次、引入 CompactionRung（[G8](./gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)） |
| 2 | **usage 估算重构** | [usage-估算/](./usage-估算/) | 锚点估算 → 标定式估算；修复双计；mask 天然可见；压缩控制与 UI 显示共用一个估算、双投影 | 方案 ③ 标定（[G12](./gaps-and-decisions.md#g12锚点估算器看不见-mask--改标定式估算)） |
| 3 | **投影层阶段链** | [投影层/](./投影层/) | storage→inference 收成命名链（削减/渲染两半）；新增可逆 mask（路线图 2.2），与永久 prune 互补 | mask 默认关闭+dark ship、黑名单豁免、ToolPart only、mandatory 事件 |
| 4 | **Origin 来源追踪** | [origin/](./origin/) | 不建 taxonomy，只做 `getMessageOrigin` 收口接缝；推迟到 Phase 6 注入系统 | ADR：推迟 taxonomy + 收口访问器 |
| 5 | **压缩多策略** | [压缩多策略/](./压缩多策略/) | 不建插件接口；显式化升级阶梯 + 补反抖动锁 + 每轮上限 | 纯函数决策、反抖动锁、每轮上限、0.95 阈值 |

**依赖链（建议实施顺序）**：

```
① 编排层（runCompaction 脊椎）
      │  产出 projectedHistory（MessageWithParts[] 工作集）
      ▼
② usage-估算（标定式估算，修复 G1/G7/G9 的前提）
      │  estimate = heuristic(工作集) × factor
      ▼
③ 投影层（reduce/render 两半，mask 削减段夹在压缩门限前）
      │  mask 阈值 + summary 阈值；mask 依赖 ② 的可见性
      ▼
⑤ 压缩多策略（把 ①③ 的触发阈值归一成升级阶梯 + 护栏）
      │  0.95 阈值依赖 ② 的精度

④ origin —— 旁路，不阻塞 ①②③⑤，仅做收口接缝，taxonomy 推迟
```

四个主链层咬合成一套连贯生命周期：**①管"永久删多少（脊椎）" → ②管"用多少 token（测量）" → ③管"这次构建临时藏多少 + 怎么变 wire（投影）" → ⑤管"哪个 usage 触发哪一级 + 别抖动（阶梯护栏）"**。④ origin 是旁路收口，不阻塞主链。

---

## 升级阶梯全景（五层合起来的最终形态）

> 阈值变更：prune-summary 从 0.85 提升到 **0.95**——充分利用 context window，overflow force 兜底估算误差（[G9](./gaps-and-decisions.md#g9prune-summary-阈值-085--095)）。该行为变更在 usage 标定落地后、压缩多策略批次中切换；编排层重构批次只预留 `CompactionRung` 接缝，保持行为可对照。不设预防性 force（[G10](./gaps-and-decisions.md#g10去除-095-预防性-force)）。

```
usage <0.5   none      正常构建
usage ~0.5   mask      投影层可逆遮罩老工具输出（便宜、不写库）        ← 第一道
usage 0.95   prune     编排层永久修剪老工具输出 + LLM 摘要              ← 第二道
remaining<4096 prune    近上限小硬地板，KISS 兜住估算低估风险            ← 辅助保护
overflow     force     lifecycle 捕获 overflow error，终极兜底          ← 兜底
护栏         反抖动锁 + 每轮压缩上限（压缩多策略层）
```

**三档而非四档**：`none → mask → prune-summary`，`force` 仅由 overflow error 触发（lifecycle 传入 `force=true`），不从 usage ratio 推导。阶梯决策由纯函数 `decideCompactionRung` 统一返回 `none | mask | prune-summary | force`（[G8](./gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）。

---

## 贯穿五层的若干结论与待确认项

1. **UI 读取路径（已核实，结论修正）**：CLI TUI **不直读** message store，走后端线路——服务端 `adapters/ui-state/persistent-store.ts` 读 `listBySession` → `messageToUiMessage`（DTO `UiMessage`/`UiSnapshot`）→ 跨 daemon/SDK → TUI。证据：TUI 零 import `core/message`/`database-store`/`listBySession`，只消费 `ohbaby-sdk` 的 `UiMessage`。这是正确架构（DTO 边界解耦），建议保持。
   - **关键修正**：UI 投影**同样应用 `isActivePart`**，并把摘要替换成 `"Context compacted"` 占位（persistent-store.ts:125-138）。即被 prune 的内容**从 UI 也消失**，唯一审计留存是 SQLite 直查。故 mask vs prune 的"审计"对两者都只靠 SQLite，与 UI 无关——之前"mask 可逆论据之一是 UI 直读 store 展示全量"的措辞作废；mask 的真实价值是"频率 + 痕迹"，不依赖审计，推荐不变。
   - **架构澄清**：message store 有两条**独立兄弟投影**——模型投影（`serializeForLlm`，即投影层）与 UI 投影（`persistent-store.messageToUiMessage`），各自滤 active part。本轮 mask 只动模型投影。若将来要"UI 展示全量历史供审计"（路线图 2.5 理想），那是对 **UI 投影**的独立改动（不滤 compacted、改占位显示），与模型 mask 解耦。
2. **improve-2 Phase 5 措辞（已处理）**：Phase 5 把 origin 当低垂果实，origin ADR 重新评估为推迟。已在 improve-2 Phase 5 加指向本 ADR 的注记，避免结论打架。
3. **mask 默认关闭 + dark ship（[G2](./gaps-and-decisions.md#g2mask-缺-kill-switch)）**：mask 是 improve-3 里唯一改变模型可观察输入的新行为。`maskEnabled` 默认 false——跑逻辑、算统计、发事件（[G3 mandatory](./gaps-and-decisions.md#g3mask-事件-mandatory)），但**不替换占位符**。dark ship 数据验证"mask 本会延迟 ≥1 次 prune-summary"后再翻开关。
4. **mask 与 prune 的读口径（[G1](./gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）**：prune 读 mask 前历史（"档案里可回收多少"），usage 基于 mask 后历史（"实际发给模型多少"）。两个不同问题，两个口径。mask 跑两次幂等（cutoff 单调，第二次不推进）。

---

## 护栏（improve-3 通用）

- 每个子主题先写失败测试再改实现（TDD），行为保持型重构先固化 characterization。
- `core/context` 不新增对 `runtime`/`adapters`/`agents`/UI 的依赖。
- 反过早抽象：不建无第二实现的接口（origin taxonomy、CompactionStrategy）。
- 内存态状态（mask cutoff、反抖动锁、每轮计数）不写库，单进程下不持久化。
- 修改返回结构/事件时同步核对 `events.ts` 的 Zod schema。
