# 4. 测试与验收标准

## 4.1 测试范围

| 类型 | 覆盖 |
|------|------|
| 单测 | path 门面（darwin/linux/win32 分支）、派生路径、迁移幂等/冲突/skip、loader 读新/fallback 旧、写只写新 |
| 集成 | 临时 `HOME`/`OHBABY_HOME` 下启动加载 model+mcp+env；DB 打开指向新数据根 |
| 回归 | daemon `~/.ohbaby/server` 行为不变；skill-output 仍在 `<ws>/.ohbaby/skill-output` |
| 手工 | 真实机器上存在旧 `~/.ohbaby-agent` 时升级一次，确认配置与会话仍可用 |

---

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Phase |
|----|------|------|--------|---------------|
| T1 | 默认 home 解析 | 单测 | `resolveOhbabyHome()` → `join(homedir,'.ohbaby')` | P1 |
| T2 | `OHBABY_HOME` 覆盖 | 单测 | 指向临时目录且 canonicalize | P1 |
| T3 | 项目根 | 单测 | `join(project,'.ohbaby')` | P1 |
| T4 | 数据根 Linux | 单测 | `XDG_DATA_HOME/ohbaby` 或 `~/.local/share/ohbaby` | P1 |
| T5 | 数据根 macOS | 单测 | `~/Library/Application Support/ohbaby` | P1 |
| T6 | 数据根 Windows | 单测 | `LOCALAPPDATA/ohbaby`（非 APPDATA） | P1 |
| T7 | 空目标自动迁移 home 配置 | 单测 | `.ohbaby-agent` → `.ohbaby`；写 marker | P2 |
| T8 | 已迁移再启动 | 单测 | 不重复拷贝；幂等 | P2 |
| T9 | 冲突不覆盖 | 单测 | 目标已有不同 `model.json` → sibling 或 skip + warn | P2 |
| T10 | skip 标记 | 单测 | `.skip-auto-migrate` 存在则不迁 | P2 |
| T11 | 数据目录 rename + db 改名 | 单测 | `ohbaby-agent` → `ohbaby`，`ohbaby-agent.db` → `ohbaby.db` | P2 |
| T12 | 旧 XDG OHBABY.md → `~/.ohbaby/OHBABY.md` | 单测 | memory 与 custom-instructions 同文件 | P2 |
| T13 | 项目级 `.ohbaby-agent` 迁移 | 单测/集成 | 进入项目后配置在 `.ohbaby` | P2 |
| T14 | 写路径只写新 | 单测 | writer 创建 `~/.ohbaby/...` 而非旧路径 | P2/P3 |
| T15 | 读 fallback | 单测 | 仅旧路径有 mcp 时仍能 load（若本批保留 fallback） | P2 |
| T16 | UI 路径展示 | 单测 | 截断标记含 `.ohbaby/` | P3 |
| T17 | daemon 回归 | 单测 | `scope` 仍解析 `~/.ohbaby/server` | 回归 |
| T18 | `rg` 门禁 | 脚本/CI 或手工 | `packages/` 生产代码无裸写 `.ohbaby-agent`（除 legacy 模块） | P3 |
| T19 | `OHBABY_HOME` 契约 | 单测 | 绝对路径作为完整配置根；相对路径明确失败 | P1 |
| T20 | SQLite WAL 整组迁移 | 单测/集成 | `.db`、`-wal`、`-shm` 不被拆散 | P2 |
| T21 | live daemon 拒绝数据迁移 | 集成 | 活跃 PID/迁移锁存在时不复制 DB、不切换路径 | P2 |
| T22 | 并发首启与崩溃重跑 | 集成 | 只有一个迁移者；临时文件不被当成完成结果 | P2 |
| T23 | server 直调启动 | 集成 | 绕过 CLI 调用 `startDaemonServer()` 仍先完成数据迁移 | P2 |

---

## 4.3 集成边界

- **CLI 启动 → migrate → loadRuntimeEnv → load model/mcp**：顺序错误会导致读到空配置。
- **Server/daemon 启动**须同样跑迁移，避免 TUI 与 daemon 各见一套根。
- **DB 连接**：迁移后 `resolveDatabasePath()` 必须打开新文件；旧连接缓存需避免跨路径。
- **多进程**：两进程同时首启迁移 — 依赖 mkdir/rename 原子性 + marker；验收关注不损坏文件。
- **SQLite**：仅 marker 不足以保证安全；必须验证迁移锁、live daemon 检测及 DB/WAL/SHM 整组处理。

---

## 4.4 回归清单

- [ ] `.env` 优先级仍为：shell > 项目 `.env` > 全局 `.env`
- [ ] 全局 daemon 单实例与 legacy 拒绝逻辑不变
- [ ] skill-output 路径仍在项目 `.ohbaby/skill-output`
- [ ] 项目根 `OHBABY.md` 仍优先于 `.ohbaby/OHBABY.md` fallback
- [ ] `OHBABY_DB_PATH` / `OHBABY_STORAGE_ROOT` 显式覆盖仍生效
- [ ] 现有 mcp / skills / agents loader 单测全绿（路径更新后）

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| A1 | 新安装只出现 `.ohbaby` 与平台 `ohbaby` 数据目录 | 空 home 跑一次 CLI；`ls` 检查 |
| A2 | 旧安装升级后配置可用（model/mcp/.env） | 预置 `~/.ohbaby-agent` fixture → 启动 → 迁移 → 功能 smoke |
| A3 | 无双源 OHBABY.md | memory 与 custom-instructions 解析同一全局路径 |
| A4 | Win 数据不在 Roaming | 单测 T6；文档说明 LocalAppData |
| A5 | 文档权威路径为 `.ohbaby` | README + architecture §8.1 更新 |
| A6 | 生产代码无配置根残留 | T18 `rg` |
| A7 | `.gitignore` 含 `.ohbaby/` | 查仓库根 gitignore |

---

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| 迁移覆盖用户已手建的 `~/.ohbaby` | 冲突不覆盖 + sibling | 用户需手动合并 sibling |
| 半迁移 + 进程崩溃 | 幂等重跑；按文件跳过已存在目标 | 极端情况下旧新各一半，靠日志 |
| 只迁 home 不迁项目 | 项目加载前迁移 | 多项目旧目录残留直至进入该项目 |
| 两工具同时写 DB 路径切换 | 单 DB 文件 rename 后旧路径打开失败 | 文档提示升级前停掉所有 ohbaby 进程 |
| 测试漏 win32 分支 | T6 强制；CI 若无 win 则单测 mock `platform()` | 真机 Win 需至少一次手工 |

---

## 4.7 Phase ↔ 验收映射

| Phase | 最低验收 |
|-------|----------|
| P1 | T1–T6、T19 绿 |
| P2 | T7–T15、T20–T23、A2、A3 |
| P3 | T16、T18、A6 |
| P4 | A5、A7 |
| 发布 | A1–A7 + 回归清单 |
