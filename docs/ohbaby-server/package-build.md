# ohbaby-server · package-build（包构建与发布接线）

> 本文只回答 `packages/ohbaby-server` 这个包如何落到当前 monorepo 的构建、类型检查、测试、npm 发布链路里。架构职责见 [`goals-duty.md`](./goals-duty.md)，实施顺序见 [`migration-sequence.md`](./migration-sequence.md)。

> **v0.1.4 transitional state:** `ohbaby-server` owns copied auth/protocol/coordination primitives and exposes explicit server/remote entrypoints. Remote client code now lives in `ohbaby-server`; lifecycle/HTTP server start/status/stop still delegates to existing `ohbaby-agent` exports until the deeper `runtime/daemon/server.ts` split is completed. This keeps default CLI in-process and avoids reversing the dependency direction.

---

## 1. 包定位

`ohbaby-server` 是**库包**，不是用户直接全局安装的 CLI 包。用户仍然只安装：

```bash
npm install -g ohbaby-cli
```

`ohbaby-cli` 在显式 server/remote 场景依赖并调用 `ohbaby-server`：

- `ohbaby` 默认：不触达 `ohbaby-server`。
- `ohbaby serve`：调用 `ohbaby-server` 的 foreground server 入口。
- `ohbaby --remote-port ...` / 后续 `ohbaby attach <url>`：调用 `ohbaby-server` 的 remote client。

---

## 2. package.json

新增：

```text
packages/ohbaby-server/package.json
```

建议字段：

```json
{
  "name": "ohbaby-server",
  "version": "0.1.4",
  "description": "Explicit local server and remote client adapters for ohbaby",
  "type": "module",
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist/**/*.js",
    "dist/**/*.js.map",
    "dist/**/*.d.ts",
    "dist/**/*.d.ts.map",
    "!dist/**/*.test.d.ts",
    "!dist/**/*.test.d.ts.map",
    "!dist/**/*.unit.test.d.ts",
    "!dist/**/*.unit.test.d.ts.map",
    "!dist/**/*.contract.test.d.ts",
    "!dist/**/*.contract.test.d.ts.map",
    "!dist/**/*.integration.test.d.ts",
    "!dist/**/*.integration.test.d.ts.map",
    "README.md"
  ],
  "sideEffects": false,
  "scripts": {
    "build": "rimraf dist && tsup && tsc -b --force",
    "typecheck": "tsc -b",
    "clean": "rimraf dist coverage"
  },
  "dependencies": {
    "ohbaby-agent": "workspace:*",
    "ohbaby-sdk": "workspace:*"
  }
}
```

版本号在实施时应与 workspace 其他 public packages 同步到 v0.1.4。本期 transitional package 不引入 Hono；后续若 web/app 协议适配启用，再按 lockfile 实际版本补充依赖。

---

## 3. TypeScript project reference

新增：

```text
packages/ohbaby-server/tsconfig.json
```

建议：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "coverage", "node_modules"],
  "references": [
    {
      "path": "../ohbaby-sdk"
    },
    {
      "path": "../ohbaby-agent"
    }
  ]
}
```

root `tsconfig.json` 需要新增 reference，顺序建议：

```json
{
  "path": "./packages/ohbaby-server"
}
```

放在 `ohbaby-agent` 之后、`ohbaby-cli` 之前。迁移后如果 `ohbaby-cli` import `ohbaby-server`，`packages/ohbaby-cli/tsconfig.json` 也要增加对 `../ohbaby-server` 的 reference。

---

## 4. tsup config

新增：

```text
packages/ohbaby-server/tsup.config.ts
```

建议沿用现有包风格：

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  outDir: "dist",
  treeshake: true,
  minify: false,
  shims: true,
  external: [
    "fs",
    "path",
    "os",
    "crypto",
    "http",
    "net",
    "stream",
    "url",
    "ohbaby-agent",
    "ohbaby-sdk"
  ]
});
```

显式 server/remote 路径所需的 workspace 依赖建议 external 化，让 npm 依赖按 package manager 解析，避免 bundle 后调试困难。

---

## 5. workspace 与依赖方向

当前 `pnpm-workspace.yaml` 已覆盖：

```yaml
packages:
  - packages/*
```

因此新增包不需要改 workspace 文件。

迁移后的依赖方向：

```text
ohbaby-sdk
  ▲
  ├── ohbaby-agent
  │     ▲
  │     └── ohbaby-server
  │             ▲
  │             └── ohbaby-cli
```

解释：

- `ohbaby-agent` 依赖 `ohbaby-sdk`，提供领域 backend。
- `ohbaby-server` 依赖 `ohbaby-agent` + `ohbaby-sdk`，提供显式 server/remote client。
- `ohbaby-cli` 依赖 `ohbaby-agent` 做默认 in-process，依赖 `ohbaby-server` 做显式 serve/remote。
- 禁止 `ohbaby-agent` import `ohbaby-server`。

---

## 6. 构建与验证命令

新增包后，至少跑：

```bash
pnpm install
pnpm --filter ohbaby-server build
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:integration
pnpm run build
```

迁移完成后，npm 本机验证必须覆盖：

```bash
pnpm run build
pnpm exec vitest run tests/integration/cli/packaging-smoke.integration.test.ts --passWithNoTests
ohbaby
ohbaby serve --port 4096
ohbaby --remote-port 4096
```

`packaging-smoke.integration.test.ts` 必须模拟真实发布拓扑：先 pack `ohbaby-sdk` / `ohbaby-agent` / `ohbaby-server` / `ohbaby-cli`，再通过临时本地 registry 只执行 `npm install -g ohbaby-cli@<version>`。测试需要读取每个 `.tgz` 内部的 `package/package.json`，确认没有 `workspace:` 依赖残留，避免用测试代码手动改写 manifest 造成假阳性。

实际命令可根据仓库当前 pack 脚本调整，但验证含义不变：

- 默认 `ohbaby` 不创建 daemon state/pid 文件。
- `ohbaby serve` 是显式 server。
- remote 连接只在用户显式传参时发生。

---

## 7. npm 发布顺序

用户只安装 `ohbaby-cli`，但 npm registry 上依赖包必须先存在。发布顺序建议：

1. `ohbaby-sdk@0.1.4`
2. `ohbaby-agent@0.1.4`
3. `ohbaby-server@0.1.4`
4. `ohbaby-cli@0.1.4`

若 `ohbaby-cli` 的 `dependencies` 指向 `ohbaby-server`，必须先发布 `ohbaby-server`，再发布 `ohbaby-cli`。

---

## 8. README 与用户说明

`ohbaby-server` 包 README 面向开发者即可，不作为用户安装入口。用户文档仍应写：

```bash
npm install -g ohbaby-cli
ohbaby
```

v0.1.4 release notes 需要单独说明：

- 默认 `ohbaby` 不再启动隐藏 daemon。
- `--daemon` / `--in-process` 已删除。
- 需要显式 server 时使用 `ohbaby serve`，需要显式连接时使用 remote 参数或后续 `ohbaby attach`。
