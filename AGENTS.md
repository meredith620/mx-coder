---
# HARNESS METADATA
# type: entry-point
# part-of: harness-architecture
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
---

# AGENTS.md - mm-coder Harness

> **Agent 通用入口文档** —— 适用于 Claude Code、Agent 等任何 Agent 系统
>
> ⚠️ **HARNESS 文件**: 本文档属于 Harness 架构，修改需谨慎

## 项目概览

**mm-coder** 是 AI CLI 会话桥接工具：管理多个 AI CLI 会话，支持终端直接交互和 IM（Instant Messaging）远程交互，两端交替使用同一会话上下文。

| 属性 | 值 |
|------|-----|
| **技术栈** | TypeScript / Node.js (NATS/nondo) |
| **运行时** | Node.js 20+ |
| **核心功能** | 多 session 管理、终端/IM 双通道访问、权限审批路由 |
| **数据持久化** | JSON 文件（`sessions.json`）+ Unix socket IPC |
| **测试框架** | Vitest + tsd + MSW |

## 快速开始

### 开发环境

```bash
# 1. 安装依赖
npm install

# 2. 类型检查
npm run check

# 3. 运行测试（开发模式，监听文件变化）
npm test

# 4. 构建
npm run build

# 5. 启动 daemon（开发）
npm run daemon -- start
```

### Harness 安装与设置

**首次克隆项目后**，需要运行以下命令来启用 Harness 自动检查：

```bash
# 1. 链接 Git Pre-Commit Hook（自动运行架构验证和提交前检查）
make harness-install

# 或手动链接：
ln -sf ../../.harness/scripts/pre-commit.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# 2. 验证 Harness 安装
./.harness/scripts/list.sh

# 3. 运行架构验证
./.harness/scripts/validate-arch.sh
```

**Harness 工具说明**：

| 命令 | 说明 |
|------|------|
| `./.harness/scripts/list.sh` | 列出所有 Harness 文档和工具 |
| `./.harness/scripts/validate-arch.sh` | 运行架构合规性检查 |
| `./.harness/scripts/pre-commit.sh` | 提交前自动检查（被 git hook 调用） |
| `./.harness/scripts/prepare-commit.sh` | 原子提交辅助工具 |
| `./.harness/scripts/evaluate-guards.sh` | 运行熵防护规则检查 |

**未安装时的手动检查**：

```bash
./.harness/scripts/pre-commit.sh
./.harness/scripts/validate-arch.sh
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run check` | TypeScript 类型检查 |
| `npm test` | 运行全部测试（Vitest） |
| `npm run test:unit` | 仅单元测试（Layer 1） |
| `npm run test:unit -- --watch` | 监听模式运行单元测试 |
| `npm run test:coverage` | 测试覆盖率报告 |
| `npm run build` | 构建产物到 `dist/` |
| `npm run daemon -- start` | 启动 daemon |
| `npm run daemon -- tui` | 启动 TUI 监控面板 |

## 项目结构

```
mm-coder/
├── AGENTS.md                 ⭐ Agent 通用入口（本文档）
├── harness.yaml              ⭐ Harness Manifest
├── .harness/                 📁 Harness 架构目录（与项目代码分离）
│   ├── specs/                📖 规范文档
│   │   ├── architecture.constraint.md  📁 架构约束（分层/依赖方向/模块组织）
│   │   ├── testing.spec.md            📁 测试规范（三层测试架构）
│   │   ├── release.spec.md            📁 发布规范（版本策略/发版流程）
│   │   ├── harness-evolution.spec.md   📁 Harness 演进规则
│   │   └── ipc-plugin.spec.md         📁 IPC 通信 + 插件系统规范
│   ├── scripts/              🔧 Harness 脚本
│   │   ├── list.sh
│   │   ├── validate-arch.sh
│   │   ├── pre-commit.sh
│   │   ├── pre-config-change.sh
│   │   ├── evaluate-guards.sh
│   │   └── prepare-commit.sh
│   └── guards/               🛡️ 熵防护规则
│       ├── protect-harness-files.rule
│       ├── no-direct-config-modification.rule   ⚠️ mm-coder 不适用（无配置文件）
│       ├── require-test-coverage.rule
│       ├── enforce-layer-separation.rule
│       └── enforce-atomic-commits.rule
├── src/                      📁 源代码
│   ├── index.ts              # CLI 入口（命令解析）
│   ├── daemon.ts             # Daemon 主进程
│   ├── session-registry.ts   # Session 注册表
│   ├── ipc/                  # IPC 通信层（Unix socket）
│   ├── plugins/              # 插件系统
│   │   ├── types.ts          # 插件接口定义
│   │   ├── plugin-host.ts    # 插件加载器
│   │   ├── im/               # IM 插件（首个：Mattermost）
│   │   └── cli/              # CLI 插件（首个：Claude Code）
│   ├── config/               # 配置管理
│   └── utils/                # 工具函数
└── tests/                    📁 测试目录（跟随源码结构）
    ├── unit/                 # Layer 1 单元测试
    ├── integration/          # Layer 2 集成测试
    └── fixtures/             # 测试数据
```

## 代码规范

### TypeScript

- **严格模式**：`"strict": true`，不允许隐式 any
- **错误处理**：使用自定义 `Result` 类型或 throws 约定，不滥用 `any`
- **异步**：Node.js 原生 `async/await`，不混用 callback
- **日志**：`console.log` 用于 CLI 输出；结构化日志用项目内部 logger
- **类型定义**：优先 `interface`，仅对联合类型/字面量使用 `type`

### 关键模式

```typescript
// 1. SessionRegistry - Session 元数据管理 + 状态机
export class SessionRegistry {
  private sessions = new Map<string, Session>();

  create(name: string, opts: CreateOpts): Session;
  list(): SessionInfo[];
  markAttached(name: string, pid: number): void;
  markDetached(name: string, reason?: Session['lastExitReason']): void;
}

// 2. IMWorkerManager - Claude Code 长驻进程管理
export class IMWorkerManager {
  spawn(session: Session): Promise<number>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;
}

// 3. MCP Permission Server - daemon 充当 MCP server 处理权限审批
export class MCP PermissionServer {
  // 实现 can_use_tool MCP tool
  // 路由到 IM 进行用户审批
}
```

## 测试策略

```
Layer 1: 单元测试 (Vitest)     → npm run test:unit
Layer 2: 集成测试 (Vitest)      → npm run test:integration
Layer 3: E2E 测试 (Shell 脚本)  → npm run test:e2e
```

### 测试分层

| 层级 | 范围 | 依赖 | 位置 |
|------|------|------|------|
| Layer 1 | 单个模块内部逻辑 | 无外部依赖，mock 所有 IO | `tests/unit/**/*.test.ts` |
| Layer 2 | 模块交互 / IPC 通信 | Mock Unix socket, mock 子进程 | `tests/integration/**/*.test.ts` |
| Layer 3 | 完整用户流程 | 真实 daemon + Claude Code | `e2e/tests/*.sh` |

### 测试开发流程

> **每个功能模块：先写测试验证，再进入人工验证**

1. 分析功能模块，识别公共 API 表面
2. 为公共 API 编写 Layer 1 单元测试（mock 所有外部依赖）
3. 实现功能模块
4. Layer 1 测试通过 → 进入人工验证
5. 功能稳定后，编写 Layer 2 集成测试
6. Layer 2 通过 → 提交流程

### E2E 测试辅助

E2E 测试使用 `e2e/tests/assert.sh` 中的标准断言函数：

```bash
# 引入辅助函数
source "$(dirname "$0")/assert.sh"

# 使用断言
assert_eq "$STATE" "idle" "初始状态应为 idle"
assert_contains "$OUTPUT" "session created" "输出应包含创建成功信息"
```

### 运行测试前必须检查

1. `npm run check` 无类型错误
2. `npm run test:unit` 全部通过
3. `npm run test:integration` 全部通过

> 详细测试规范见 [`.harness/specs/testing.spec.md`](.harness/specs/testing.spec.md)

## 架构约束

1. **Daemon 单进程**：daemon 是单一 Node.js 进程，通过 Unix socket 接收 CLI 命令
2. **IM Worker 隔离**：每个 session 的 Claude Code 进程独立，daemon 不直接持有 AI CLI 控制面
3. **插件隔离**：IM Plugin 和 CLI Plugin 独立加载，插件崩溃不导致 daemon 崩溃
4. **权限审批分层**：daemon 充当 MCP server，IM 审批不阻塞终端使用
5. **无 root 依赖**：所有文件操作在用户目录下，不依赖 root 权限

## 依赖 Harness 文档

Agent 应根据任务类型加载对应规范：

| 任务类型 | 加载文档 |
|----------|---------|
| 架构修改 / 分层 | `.harness/specs/architecture.constraint.md` |
| 添加测试 | `.harness/specs/testing.spec.md` |
| 发布构建 | `.harness/specs/release.spec.md` |
| IPC / 插件开发 | `.harness/specs/ipc-plugin.spec.md` |
| 修改 Harness | `.harness/specs/harness-evolution.spec.md` |

## 约束与红线

⛔ **永远不要:**
- 跳过测试直接提交（`npm test` 必须通过）
- 在 `src/` 目录下直接 import IM 插件的实现代码（必须通过插件接口）
- 在 `src/daemon.ts` 中硬编码 CLI Plugin 的具体实现
- 删除 `tests/` 中的测试（功能必须有测试覆盖）
- 直接修改 `~/.config/mm-coder/sessions.json` 而不通过 daemon API

✅ **始终:**
- 提交前运行 `./.harness/scripts/pre-commit.sh`
- 新增功能时同步添加测试（Layer 1 优先）
- 遵循分层约束（见 `.harness/specs/architecture.constraint.md`）

---
*Harness Version: 1.0 | Last Updated: 2026-04-13*
