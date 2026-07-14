# Loop 模块 test.md

> 验证职责是否成立，而非堆砌实现细节。若仓库已有 test-blueprint，本模块测试归类遵循项目惯例（unit / integration）。

---

## 一、Test Scope（范围）

### 必须覆盖

- 创建校验（serve、上限、session、间隔）  
- 到期门控四分支：可投递 / 忙则 coalesce / inflight skip / paused discard  
- 多 job FIFO  
- 创建后首次入队安排  
- stale 最后一次 + 删除  
- pause 清 pending；resume 不补投  
- serve 重启恢复 job + pending  
- TUI claim ⇒ 不可投递  
- 工具注册矩阵：主 Agent 有、子 Agent 无、in-process TUI 无  
- Plan 模式：List 可、Create/Delete 不可  

### 不必须（MVP）

- 侧栏 UI  
- jitter  
- 工作区型 Loop  
- 与真实 LLM 的端到端（可用 fake lifecycle）  

---

## 二、Critical Scenarios（关键场景）

| ID | 场景 | 期望 |
|----|------|------|
| C1 | session 空闲到期 | 入队 1 次；coalescedCount=1；nextFireTime 推进 |
| C2 | 连续 3 次到期均忙 | pending 保持 1；coalescedCount=3；变闲后只入队 1 次 |
| C3 | 同 job 仍在 running 时到期 | skip；不增加第二执行 |
| C4 | paused 时到期 | 不 pending；resume 后等到下一自然点 |
| C5 | 两 job 同时到期 | 按时间 FIFO 串行入队 |
| C6 | 创建 | 立即有首次入队或 pending；返回 jobId |
| C7 | 第 7 天窗口末可投递 | 入队 stale=true 后 job 消失 |
| C8 | 删除 session | 其 loops 全无 |
| C9 | 无 serve 创建 | 失败 |
| C10 | in-process 工具表 | 无 Loop* |
| C11 | 入队后 run fail | job 仍 active，下周期仍 due |

---

## 三、Integration Points（集成点）

| 协作方 | 测什么 |
|--------|--------|
| Scheduler | fake clock：到期只产生 Due，不直接入队 |
| PromptScheduler | accept 被调用次数与 prompt 含信封字段 |
| run-ledger claim | 模拟 TUI owner ⇒ gate 判忙 |
| InstanceStore | 错误 scope 不投错 workspace |
| REST/工具 | 同一管理服务，行为一致 |

---

## 四、Verification Strategy（策略）

1. **单元**：门控纯函数/类 + fake clock + 内存 store  
2. **集成**：serve 进程内 Scheduler + Gate + 内存/测试 DB PromptScheduler  
3. **契约**：工具 schema / Plan deny 列表 / TUI 工具注册快照测试  
4. **手工验收（Web）**：创建 `/loop 5m …` → 侧栏可见 → 忙时合并 → pause/resume → 近逾期 stale（可调短窗口测）  

---

## 五、不可接受失败（测试红线）

- 测到同 job 并行两 run  
- 测到 TUI claim 下仍 accept 成功抢跑  
- 测到 paused 恢复瞬间强制补跑暂停期所有到期  
- 测到子 Agent 或 in-process TUI 能 LoopCreate  

---

## 六、文档自检

- [x] 场景对齐 duties 与 use-case  
- [x] 不测内部堆实现细节，只测 Due 之后行为  
