# project 模块 goals-duty.md

本文档定义 `project` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/project/`
- 文档：`docs/project/`

---

## 一、模块定位

**一句话说明**：project 模块负责识别和管理项目边界，为会话和记忆模块提供稳定的项目标识和根路径。

**如果没有这个模块**：
- Session 模块需要自己实现项目识别逻辑，职责不清
- Memory 模块无法确定项目级 OHBABY.md 文件的位置
- 项目 ID 生成逻辑分散在多处，难以保持一致性
- 非 Git 目录的处理缺乏统一策略

---

## 二、Design Goals（设计目标）

### G1: 稳定标识

项目 ID 必须稳定可靠：
- 同一 Git 仓库在不同机器上应产生相同的 projectId
- 目录移动不应改变 Git 项目的 projectId
- ID 生成算法必须确定性，无随机成分

### G2: 简单动态

不持久化项目元数据，每次启动时动态识别：
- 减少数据同步问题
- 避免"陈旧"项目数据
- 降低模块复杂度

### G3: 解耦设计

Project 模块只负责识别，不负责管理：
- 只返回 projectId 和根路径
- 不维护项目下的会话列表（由调用者查询 Session）
- 不存储项目配置（由 Config 模块负责）

### G4: 明确边界

清晰区分项目类型：
- Git 项目：基于 Git root commit hash 识别
- 非 Git 目录：统一归为 `id: "global"`
- 全局项目作为特殊情况处理

---

## 三、Duties（职责）

### D1: 项目识别

从给定目录路径识别项目信息：
- 向上查找 `.git` 目录确定项目根
- 生成稳定的 projectId
- 返回项目根路径（worktree）

**核心接口**：`Project.fromDirectory(directory: string): Promise<ProjectInfo>`

### D2: projectId 生成

生成稳定且唯一的项目标识符：
- **Git 项目**：使用 `git rev-list --max-parents=0 --all` 获取 root commit hash
- **非 Git 目录**：返回固定值 `"global"`
- 确保同一仓库在任意位置产生相同 ID

### D3: 项目根路径发现

定位项目的根目录：
- Git 项目：返回 `.git` 所在目录（worktree）
- Global 项目：返回当前工作目录或 "/"

### D4: 项目类型判断

判断目录是否属于 Git 项目：
- 检测 `.git` 目录存在性
- 返回 VCS 类型（`'git'` 或 `undefined`）

---

## 四、Non-Duties（非职责）

### N1: 不负责项目元数据持久化

项目名称、图标等元数据不由 Project 模块存储。每次调用都是动态识别。

### N2: 不负责项目配置管理

项目级配置文件（如 `.ohbaby-agent/settings.json`）由 Config 模块负责加载和管理。

### N3: 不维护项目下的会话列表

Project 模块不知道项目下有哪些会话。如需查询，调用者应直接使用 Session 模块的 `getByProject()` 接口。

### N4: 不负责全局配置目录管理

全局配置目录（XDG 标准路径）的定义和管理由 Path/Config 模块负责。

### N5: 不发布事件

当前版本不需要 `Project.Event.Updated` 等事件。项目识别是同步操作，无需通知机制。

### N6: 不负责项目初始化

创建 `.ohbaby-agent/` 目录、初始化项目配置等操作不是 Project 模块的职责。

---

## 五、设计约束与假设

### 约束

1. **Git 依赖**：项目识别优先依赖 Git，需要系统安装 Git 命令行工具
2. **无持久化**：不使用 Storage 模块，无文件读写
3. **同步设计**：`fromDirectory()` 是异步的（因为需要执行 Git 命令），但不涉及长时间阻塞

### 假设

1. Git 命令可用且响应迅速（通常 < 100ms）
2. 同一目录的多次调用应返回相同结果
3. 项目根目录在运行期间不会改变

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| Session | 被依赖 | Session.create 调用 Project.fromDirectory 获取 projectId |
| Memory | 被依赖 | Memory 使用 projectRoot 定位项目级 OHBABY.md |
| Config | 并行 | Config 使用 projectRoot 定位项目级配置文件 |
| Storage | 无依赖 | Project 模块不持久化数据 |
| lifecycle | 间接 | lifecycle 通过 Session 间接使用 projectId |

**依赖方向**：Project 是底层模块，不依赖任何业务模块。

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
