---
# HARNESS METADATA
# type: constraint
# part-of: harness-architecture
# scope: architecture
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
---

# 架构约束

> **适用于:** 任何涉及架构变更的任务
>
> ⚠️ **HARNESS 文件**: 本文档属于 Harness 架构，修改需谨慎

## 核心架构

```
┌──────────────────────────────────────────────────────┐
│  Layer 1: 表示层 (IPC Handler / CLI 命令)             │
│  - 命令解析、参数校验、输出格式化                      │
│  - 无业务逻辑，只负责协议转换                          │
├──────────────────────────────────────────────────────┤
│  Layer 2: 应用层 (Daemon Core)                        │
│  - SessionRegistry: Session 元数据 + 状态机           │
│  - IMWorkerManager: Claude Code 进程生命周期管理       │
│  - ApprovalManager: 权限审批状态机                    │
├──────────────────────────────────────────────────────┤
│  Layer 3: 插件层 (IM Plugin / CLI Plugin)             │
│  - IMPlugin: Mattermost 等 IM 平台适配                 │
│  - CLIPlugin: Claude Code 等 AI CLI 适配                │
├──────────────────────────────────────────────────────┤
│  Layer 4: 基础设施层 (进程 / 文件系统 / 网络)            │
│  - child_process: Claude Code 进程管理                 │
│  - Unix socket: IPC 通信                              │
│  - MCP Protocol: 权限审批路由                          │
└──────────────────────────────────────────────────────┘
```

## 分层约束

### 1. IPC Handler / CLI 层 (`src/index.ts`, `src/ipc/`)

**职责:**
- 解析 CLI 参数或 IPC 消息
- 调用 SessionRegistry / IMWorkerManager 方法
- 结果序列化为 JSON/文本输出

**禁止:**
- ❌ 直接 spawn Claude Code 进程（应通过 CLIPlugin）
- ❌ 直接发送 IM 消息（应通过 IMPlugin）
- ❌ 包含 Session 状态判断逻辑（应在 SessionRegistry）

**正确:**
- ✅ 调用 SessionRegistry / IMWorkerManager 方法
- ✅ 使用 `?` 传播错误

### 2. Daemon Core 层 (`src/daemon.ts`, `src/session-registry.ts`)

**职责:**
- Session 元数据管理
- 状态机维护（idle / attached / im_processing / approval_pending / takeover_pending / recovering / error）
- IM Worker 生命周期编排
- 审批状态机维护

```typescript
class SessionRegistry {
  create(name: string, opts: CreateOpts): Session;
  list(): SessionInfo[];
  markAttached(name: string, pid: number): void;
  markDetached(name: string, reason?: Session['lastExitReason']): void;
  markImProcessing(name: string, pid: number): void;
  takeover(name: string): void;  // 向终端 Claude Code 发 SIGTERM
}

class IMWorkerManager {
  spawn(session: Session): Promise<number>;    // 启动 claude -p 长驻进程
  sendMessage(sessionId: string, message: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;  // SIGTERM，干净退出
  isRunning(sessionId: string): boolean;
}
```

### 3. 插件层 (`src/plugins/im/`, `src/plugins/cli/`)

**职责:**
- IM Plugin：IM 平台协议适配、消息收发
- CLI Plugin：AI CLI 进程构建、stream-json 解析、权限拦截注入

**禁止:**
- ❌ 插件直接访问 SessionRegistry（通过 daemon 间接调用）
- ❌ 插件直接操作其他插件的资源

## 依赖方向

```
IPC/CLI → SessionRegistry / IMWorkerManager → IMPlugin / CLIPlugin
   ↓              ↓                              ↓
外部          业务逻辑                      协议适配
```

**禁止循环依赖!**

## 模块组织

```
src/
├── index.ts               # CLI 入口（命令解析）
├── daemon.ts               # Daemon 主进程
├── session-registry.ts    # SessionRegistry
├── im-worker-manager.ts   # IMWorkerManager
├── approval-manager.ts    # ApprovalManager（MCP server）
├── ipc/
│   └── socket-server.ts   # Unix socket IPC 服务端
├── plugins/
│   ├── types.ts           # IMPlugin / CLIPlugin 接口
│   ├── plugin-host.ts     # 插件加载器
│   ├── im/
│   │   └── mattermost.ts # MattermostPlugin
│   └── cli/
│       └── claude-code.ts # ClaudeCodePlugin
└── utils/
    └── logger.ts
```

## 并发约束

### IM Worker 进程隔离

每个 session 的 Claude Code 进程是独立子进程：
- daemon 使用 `child_process.spawn` 的返回值管理 PID
- daemon 通过 `imWorkerPid` 校验进程存活（`process.kill(pid, 0)`）
- 进程崩溃由 daemon 检测并触发重启（`imWorkerCrashCount`）

## 错误传播

```
基础设施错误 → 自定义 Error 子类 → Daemon 捕获 → IPC 响应
```

```typescript
export class WorkerSpawnError extends Error {
  constructor(sessionId: string, cause: Error) {
    super(`Failed to spawn worker for session '${sessionId}': ${cause.message}`);
    this.cause = cause;
  }
}
```

## 测试架构约束

| 测试类型 | 范围 | 依赖 |
|----------|------|------|
| 单元测试 | 单个类 / 函数 | mock child_process, mock socket |
| 集成测试 | IM Worker 生命周期 / IPC 通信 | Mock Claude Code 进程，Mock Unix socket |
| E2E 测试 | 完整用户流程 | 真实 daemon + Claude Code |
