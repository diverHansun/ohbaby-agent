# TypeScript 项目学习指南

## 1. 如何单独运行测试文件

在 vitest 中，有多种方式可以单独运行测试文件：

### 方法 1: 使用 npm 脚本指定文件路径

```bash
npm run test -- src/core/llm-client/llm-client.test.ts
```

或者使用完整路径：

```bash
npm run test -- ohbaby-agent/src/core/llm-client/llm-client.test.ts
```

### 方法 2: 直接使用 vitest 命令

```bash
npx vitest run src/core/llm-client/llm-client.test.ts
```

### 方法 3: 使用文件匹配模式

```bash
npm run test -- llm-client.test.ts
```

### 方法 4: 使用 watch 模式（适合开发时使用）

```bash
npm run test:watch -- src/core/llm-client/llm-client.test.ts
```

### 方法 5: 运行特定的测试用例

```bash
# 运行包含特定名称的测试
npm run test -- -t "createLLMClient"
```

**注意**：
- `--` 用于将参数传递给底层的 vitest 命令
- vitest 支持文件路径、模式匹配和测试名称匹配

## 2. 配置文件说明

### package.json

**作用**：项目的主配置文件，定义了项目的基本信息和脚本命令。

**关键内容**：
- `name`: 项目名称
- `version`: 版本号
- `scripts`: 可执行的 npm 脚本命令
  - `test`: 运行所有测试（`vitest run`）
  - `test:watch`: 监听模式运行测试（`vitest`）
  - `build`: 编译 TypeScript 代码
  - `dev`: 开发模式运行
- `dependencies`: 生产环境依赖（会被打包到最终产品中）
- `devDependencies`: 开发环境依赖（只在开发时使用，如测试工具、类型定义等）
- `type: "module"`: 使用 ES 模块系统

### package-lock.json

**作用**：锁定依赖的精确版本，确保团队协作和部署时使用相同版本的依赖。

**关键特点**：
- 自动生成，**不要手动编辑**
- 记录每个依赖包及其子依赖的确切版本
- 确保 `npm install` 在不同环境中安装相同版本的包
- 提升安装速度（缓存机制）

### tsconfig.json

**作用**：TypeScript 编译器的配置文件，定义如何编译 TypeScript 代码。

**关键配置项**：
- `target: "ES2022"`: 编译后的 JavaScript 目标版本
- `module: "NodeNext"`: 模块系统（Node.js 的 ES 模块）
- `moduleResolution: "nodenext"`: 模块解析策略
- `strict: true`: 启用严格类型检查
- `paths`: 路径别名，方便导入（如 `@/core/*` 映射到 `./src/core/*`）
- `outDir: "./dist"`: 编译输出目录
- `rootDir: "./src"`: 源码根目录
- `declaration: true`: 生成 `.d.ts` 类型声明文件

### vitest.config.ts

**作用**：Vitest 测试框架的配置文件，定义测试运行的环境和选项。

**关键配置项**：
- `globals: true`: 全局可用 `describe`、`it`、`expect` 等，无需导入
- `environment: 'node'`: 测试运行环境（Node.js）
- `exclude`: 排除的目录或文件
- `coverage`: 代码覆盖率配置
  - `provider: 'v8'`: 使用 V8 引擎的覆盖率工具
  - `reporter`: 覆盖率报告格式（text, json, html）

### prettier.config.json

**作用**：Prettier 代码格式化工具的配置，统一代码风格。

**关键配置项**：
- `printWidth: 100`: 每行最大字符数
- `tabWidth: 2`: 缩进空格数
- `semi: true`: 语句末尾使用分号
- `singleQuote: true`: 使用单引号
- `trailingComma: "es5"`: 多行时在最后一个元素后添加逗号

**使用方法**：
```bash
npm run format  # 格式化代码
```

## 配置文件之间的关系

```
package.json (项目入口)
    ├── 引用 tsconfig.json (编译配置)
    ├── 引用 vitest.config.ts (测试配置，通过 vitest 命令)
    ├── 引用 prettier.config.json (格式化配置，通过 prettier 命令)
    └── 生成 package-lock.json (依赖锁定，自动生成)
```

## 常用工作流程

1. **开发时**：
   ```bash
   npm run dev              # 运行开发服务器
   npm run test:watch       # 监听模式运行测试
   ```

2. **提交代码前**：
   ```bash
   npm run format           # 格式化代码
   npm run lint             # 检查代码规范
   npm run type-check       # 类型检查
   npm run test             # 运行所有测试
   ```

3. **构建项目**：
   ```bash
   npm run build            # 编译 TypeScript 到 dist 目录
   ```

