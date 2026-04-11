# mm-coder — 需求与设计规格

> AI CLI 会话桥接工具：管理多个 AI CLI 会话，支持终端直接交互和 IM 远程交互，两端交替使用同一会话上下文。

---

## 1. 需求

### 1.1 核心场景

个人开发者日常同时推进多个 AI CLI 任务。大部分时间在终端直接使用 Claude Code 等 AI CLI 工具，离开电脑时希望通过 IM（Mattermost 等）继续推进，回来后在终端无缝衔接。

### 1.2 关键需求

- **终端原生体验**：终端交互时直接面对 AI CLI，零中间层
- **IM 远程续接**：离开电脑后，通过 IM 继续与同一会话交互
- **多会话并行**：同时管理多个独立会话，终端和 IM 各自选择操作哪个
- **权限审批不阻塞**：终端不在时，权限请求转发到 IM 审批
- **可扩展**：IM 端（Mattermost → Slack/Discord）和 CLI 端（Claude Code → Codex/Gemini）均可通过插件扩展

### 1.3 使用流程

```
$ mm-coder start                                # 启动 daemon（一次性）
$ mm-coder create bug-fix --workdir ~/myapp     # 注册一个命名会话

# 在电脑前：终端直接交互
$ mm-coder attach bug-fix                       # 直接启动 Claude Code，原生体验
  ... 正常使用 Claude Code ...
  /exit 或 Ctrl+C                               # 退出 Claude Code = 释放会话

# 离开电脑：IM 远程交互
  → Mattermost 上发消息继续推进任务
  → 权限请求通过 IM emoji/按钮审批

# 回到电脑：终端再次接续
$ mm-coder attach bug-fix                       # 再次启动 Claude Code，自动 resume
```

---

## 2. 架构

### 2.1 核心思路：Session-based 混合方案

终端和 IM 使用不同的交互通道访问同一个 AI CLI 会话：

- **终端**：直接运行 AI CLI 命令（如 `claude --session-id <id> --resume`），用户看到的就是原生 Claude Code，没有任何代理层
- **IM**：Daemon 调用 AI CLI 的非交互模式（如 `claude -p "msg" --session-id <id> --output-format stream-json`），获取结构化输出后发送到 IM
- **互斥**：同一 session 同一时刻只有一端在操作。终端在用时 IM 提示"会话正在终端使用中"

### 2.2 整体结构

```
                    ┌──────────────────────────────────────┐
                    │           mm-coder daemon             │
                    │                                      │
                    │  ┌────────────────────────────────┐  │
                    │  │       SessionRegistry          │  │
                    │  │                                │  │
                    │  │  bug-fix   → { sessionId, ... }│  │
                    │  │  review-pr → { sessionId, ... }│  │
                    │  │  explore   → { sessionId, ... }│  │
                    │  └────────────────────────────────┘  │
                    │                                      │
                    │  ┌──────────────┐ ┌──────────────┐  │
                    │  │  IM Plugins  │ │  CLI Plugins │  │
                    │  │ ┌──────────┐ │ │ ┌──────────┐ │  │
                    │  │ │Mattermost│ │ │ │ClaudeCode│ │  │
                    │  │ └──────────┘ │ │ └──────────┘ │  │
                    │  │ ┌──────────┐ │ │ ┌──────────┐ │  │
                    │  │ │Slack ... │ │ │ │Codex ... │ │  │
                    │  │ └──────────┘ │ │ └──────────┘ │  │
                    │  └──────────────┘ └──────────────┘  │
                    └───────────┬──────────────────────────┘
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
    ┌────────▼─────┐   ┌───────▼──────┐   ┌───────▼──────┐
    │ mm-coder CLI │   │ Mattermost   │   │ AI CLI       │
    │ (用户命令)    │   │ (IM 消息)    │   │ (非交互进程)  │
    └──────────────┘   └──────────────┘   └──────────────┘
```

### 2.3 数据流

```
终端 attach:
  mm-coder attach bug-fix
    → 通知 daemon 标记 session 为 attached，上报 claude 进程 PID
    → 直接执行 claude --session-id <id> --resume（stdio: inherit）
    → 用户与 Claude Code 原生交互
    → Claude Code 退出后，通知 daemon 标记 session 为 detached
    → 如果是被 IM 端接管导致退出，显示"会话已被 IM 端接管"

IM 交互:
  用户在 Mattermost thread 中发消息
    → IM Plugin 收到消息，根据 threadId 查找关联 session
    → Daemon 检查 session 状态
    → 如果 attached:
       → 在 thread 中提示"会话正在终端使用中，是否接管？"
       → 用户选择接管 → Daemon 向终端 claude 进程发送 SIGTERM
       → Claude Code 优雅退出（session 状态自动保存）
       → session 变为 detached，继续处理 IM 消息
       → 用户选择不接管 → 消息排队等待
    → 如果 detached:
       → 启动 claude -p "msg" --session-id <id> --output-format stream-json
       → 解析 stream-json 输出
       → 发送格式化结果到对应 thread
       → 进程退出，session 保持 detached
```

### 2.4 IM 消息路由

```
Channel 主消息流 → 管理命令（/create, /list, /open 等）
  /create → 创建 session + 自动创建关联 thread
  /list   → 列出所有 session 及其 thread permalink
  /open   → 返回指定 session 的 thread 链接

Thread（每个 session 一个） → 会话交互
  threadId → SessionRegistry.getByIMThread() → 对应 session
  消息直接路由到关联 session，无需前缀或切换命令
```

### 2.5 并发模型

- 同一 session 的 IM 消息串行处理（队列），前一条处理完才处理下一条
- **不同 session 之间完全并行** — 多个 thread 可同时与各自的 session 交互
- 终端和 IM 互斥：attach 时 IM 可选择接管（SIGTERM 终止终端进程）或排队等待

---

## 3. 核心模块

### 3.1 Daemon

后台长驻进程，职责：
- 托管 SessionRegistry
- 加载并管理插件
- 接收 CLI 命令（通过 IPC）
- 接收 IM 消息并调度 AI CLI 处理

### 3.2 SessionRegistry

```typescript
interface Session {
  name: string;              // 用户定义，唯一
  sessionId: string;         // AI CLI 的 session ID（如 Claude Code 的 --session-id）
  cliPlugin: string;         // CLI 插件名
  workdir: string;
  status: 'attached' | 'detached';
  attachedPid: number | null; // 终端 claude 进程 PID（attached 时有值）
  imBindings: IMBinding[];   // 关联的 IM 线程
  messageQueue: string[];    // IM 待处理消息队列
  createdAt: Date;
  lastActivityAt: Date;
}

class SessionRegistry {
  create(name: string, opts: CreateOpts): Session;
  list(): SessionInfo[];
  remove(name: string): void;

  markAttached(name: string, pid: number): void;
  markDetached(name: string): void;
  takeover(name: string): void;  // 向终端 claude 进程发 SIGTERM，强制释放 session

  bindIM(name: string, binding: IMBinding): void;
  getByIMThread(pluginName: string, threadId: string): Session | undefined;
}
```

### 3.3 CLI 命令

```
mm-coder start                              启动 daemon
mm-coder stop                               停止 daemon
mm-coder create <name> [--workdir] [--cli]  注册新会话
mm-coder attach <name>                      直接启动 AI CLI 交互
mm-coder list                               列出所有会话
mm-coder remove <name>                      删除会话
mm-coder tui                                连接 daemon，实时监控面板
mm-coder status                             daemon 和会话状态
```

---

## 4. 插件系统

### 4.1 IM Plugin 接口

```typescript
interface IMPlugin {
  name: string;

  init(config: Record<string, unknown>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: (msg: IncomingMessage) => void): void;
  sendMessage(target: MessageTarget, content: string): Promise<void>;

  // 为新 session 创建独立 thread，返回 threadId
  createThread(channelId: string, sessionName: string): Promise<string>;

  // 权限审批
  requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<boolean>;
}
```

首个实现：**MattermostPlugin**

### 4.2 CLI Plugin 接口

```typescript
interface CLIPlugin {
  name: string;

  // 终端模式：构建交互式启动命令
  buildAttachCommand(session: Session): { command: string; args: string[] };

  // IM 模式：构建非交互式命令
  buildMessageCommand(session: Session, message: string): { command: string; args: string[] };

  // 解析非交互模式输出
  parseOutput(raw: string): ParsedOutput;

  // 权限拦截：注入权限审批机制（每个 CLI 用各自原生方案）
  // Claude Code → PreToolUse Hook
  // Codex CLI → Approval Mode API
  // Gemini CLI → Policy Engine 规则注入
  injectPermissionInterceptor(session: Session, config: PermissionConfig): void;
}
```

首个实现：**ClaudeCodePlugin**

```typescript
// 示例：Claude Code 插件实现
class ClaudeCodePlugin implements CLIPlugin {
  name = 'claude-code';

  buildAttachCommand(session: Session) {
    return {
      command: 'claude',
      args: ['--session-id', session.sessionId, '--resume'],
    };
  }

  buildMessageCommand(session: Session, message: string) {
    return {
      command: 'claude',
      args: ['-p', message, '--session-id', session.sessionId,
             '--output-format', 'stream-json', '--resume'],
    };
  }
}
```

### 4.3 插件加载

插件以 npm 包或本地目录形式存在，配置文件声明，动态 import 加载：

```yaml
plugins:
  im:
    - name: mattermost
      package: "@mm-coder/plugin-mattermost"
  cli:
    - name: claude-code
      package: "@mm-coder/plugin-claude-code"
```

---

## 5. 权限审批

### 设计原则

权限拦截由 CLIPlugin 各自实现，使用每个 CLI 的原生机制，而不是统一抽象成 MCP Permission Server。

| CLI | 原生机制 | 适用性 |
|-----|---------|--------|
| Claude Code | PreToolUse Hook（脚本，JSON stdin/stdout） | 最适合 Claude Code，直接拦截内建工具调用 |
| Codex CLI | Approval Mode / 内置安全模式 | 应复用 Codex 自带审批能力 |
| Gemini CLI | Policy Engine（声明式规则） | 应注入规则，而不是外围劫持 |

**为什么不用 MCP Permission Server 做统一审批层：**
- MCP 的职责是**提供工具**，不是**拦截 CLI 内建工具调用**
- Claude Code 的 Bash / Write / Edit 等内建工具并不是由外部 MCP server 暴露的
- 因此，MCP server 适合给模型增加能力，不适合作为 mm-coder 的统一权限拦截总线
- 未来扩展到 Codex / Gemini 时，各自都有更原生的审批机制，强行统一到 MCP 只会增加适配成本

**结论：**
- Claude Code 场景：优先使用 PreToolUse Hook
- 跨 CLI 扩展：统一上层审批状态机，底层由各 CLI plugin 接入自己的原生权限机制
- MCP 仍可用于未来为模型提供额外工具，但不承担权限审批拦截职责

### 终端模式

直接使用 AI CLI 原生审批（Claude Code 自带的终端权限确认），无需干预。

### IM 模式（以 Claude Code 为例）

通过 **PreToolUse Hook** 实现。Hook 是 Claude Code 在执行工具前调用的外部脚本，在 `-p` 非交互模式下同样生效。

**流程：**

```
claude -p 执行中，要调用 Write 工具
  → 触发 PreToolUse hook
  → hook 脚本读取 stdin 中的工具调用信息（工具名、参数等）
  → 检查白名单：如果工具在 autoAllow 中 → 直接输出 {"decision":"allow"}
  → 检查黑名单：如果匹配 autoDeny 规则 → 直接输出 {"decision":"deny"}
  → 否则：通过 Unix socket 发请求到 daemon
  → daemon 转发到 IM："⚠️ 权限请求: Write → src/auth.ts"
  → hook 脚本阻塞等待...
  → 用户在 IM 审批（👍 / 👎）
  → daemon 返回结果给 hook 脚本
  → hook 脚本输出 {"decision":"allow"} 或 {"decision":"deny"}
  → Claude Code 继续或中止
```

**配置（挂在 CLI 插件下，非全局）：**

```yaml
plugins:
  cli:
    - name: claude-code
      package: "@mm-coder/plugin-claude-code"
      permissions:
        autoAllow: [Read, Grep, Glob, WebSearch, LSP]
        autoDeny: ["Bash:rm -rf", "Bash:drop", "Bash:truncate"]
        timeout: 300
```

**实现要点：**

- mm-coder 启动 `claude -p` 时，自动注入 PreToolUse hook 配置
- hook 脚本是一个轻量进程，通过 Unix socket 与 daemon 同步通信
- daemon 维护 pending approval 状态，IM 用户审批后立即响应 hook

---

## 6. IM 交互

### 路由模型

- **Channel 主消息流**：管理命令（/create, /list, /open）
- **Thread（一对一）**：每个 session 绑定一个独立 thread，消息自动路由，无需切换命令
- **并行交互**：不同 thread 可同时与各自 session 交互，互不干扰
- **重新打开 Thread**：`/list` 显示所有 session 及 thread permalink，点击即可跳转；`/open <name>` 直接返回指定 session 的 thread 链接；若 thread 被删除，Bot 自动创建新 thread 并重新绑定

### Mattermost 示例

```
# ===== Channel 主消息流（管理命令）=====

用户: /create bug-fix ~/myapp
Bot:  ✅ 已创建 'bug-fix'
      → [点击进入 thread 开始交互]           ← Bot 自动创建 thread

用户: /create review-pr ~/other
Bot:  ✅ 已创建 'review-pr'
      → [点击进入 thread 开始交互]

用户: /list
Bot:  ● bug-fix    (idle)      ~/myapp    → [打开 thread]
      ● review-pr  (attached)  ~/other    → [打开 thread]  ← 终端使用中

用户: /open bug-fix
Bot:  → [打开 bug-fix thread]              ← 快速跳转到指定 session 的 thread


# ===== Thread A: bug-fix（直接对话，无需前缀）=====

用户: auth 模块的实现逻辑是什么？
Bot:  [Claude Code 回复，Markdown 格式化]

用户: 把 JWT 改成 session-based
Bot:  ⚠️ 权限请求: Write → src/auth.ts
      👍 允许  👎 拒绝
用户: 👍
Bot:  ✅ 已允许
Bot:  [Claude Code 完成修改的回复]


# ===== Thread B: review-pr（同时进行）=====

用户: PR 的改动有什么风险？
Bot:  ⚠️ 会话 'review-pr' 正在终端使用中
      🔄 接管（终止终端会话）  ❌ 取消
用户: 🔄
Bot:  ✅ 已接管，终端会话已终止
Bot:  [Claude Code 回复]
```

---

## 7. 配置

```yaml
# ~/.config/mm-coder/config.yaml

plugins:
  im:
    - name: mattermost
      package: "@mm-coder/plugin-mattermost"
      config:
        url: https://mattermost.example.com
        token: bot-token
        channelId: default-channel
  cli:
    - name: claude-code
      package: "@mm-coder/plugin-claude-code"
      permissions:
        autoAllow: [Read, Grep, Glob, WebSearch, LSP]
        autoDeny: ["Bash:rm -rf", "Bash:drop", "Bash:truncate"]
        timeout: 300

defaults:
  cli: claude-code
  workdir: ~/projects

persistence:
  path: ~/.config/mm-coder/sessions.json

ipc:
  socketPath: ~/.config/mm-coder/daemon.sock

ui:
  defaultMode: headless  # headless | tui
```

---

## 8. 运行模式

### Headless 模式（默认）

`mm-coder start` 启动 daemon 后在后台运行，通过普通 CLI 命令和 IM 完成交互。

**适用场景：**
- 日常使用
- 服务器 / 远程开发机
- 主要依赖 IM 远程推进任务
- 脚本化或开机自启

### TUI 模式

`mm-coder tui` 连接 daemon 的 IPC（Unix socket），显示实时状态面板。

**功能：**
- 查看所有 session 的状态（idle / attached / queue length / 最近活动时间）
- 查看哪些 session 正在等待权限审批
- 快速打开/attach/删除 session
- 实时监控多会话运行情况

**适用场景：**
- 在电脑前同时推进多个 session，需要总览面板
- 希望在单独终端 tab 中监控 daemon 状态
- 需要快速发现哪个 session 被 IM 接管、哪个在排队

**边界：**
- TUI 不是 Claude Code 的交互界面
- 真正进入某个 session 工作时，仍然执行 `mm-coder attach <name>`，直接进入原生 AI CLI
- TUI 本质上是 daemon 的监控/控制台，而不是 REPL 宿主

---

## 9. 项目结构

```
src/
├── index.ts                 # CLI 入口（命令解析）
├── daemon.ts                # Daemon 主进程
├── session-registry.ts      # Session 注册表
│
├── plugins/
│   ├── types.ts             # 插件接口定义
│   ├── plugin-host.ts       # 插件加载器
│   ├── im/
│   │   └── mattermost.ts
│   └── cli/
│       └── claude-code.ts
│
├── config/
│   └── index.ts
│
└── utils/
    └── logger.ts
```

---

## 10. 实现顺序

```
Phase 1: 核心骨架
  - Daemon + IPC 通信
  - SessionRegistry
  - CLI 命令（start/create/attach/list）
  - Claude Code 插件（attach + message 命令构建）

Phase 2: Mattermost 集成
  - IM 插件接口 + Mattermost 实现
  - IM 命令处理 + thread 关联
  - stream-json 输出解析与 Markdown 格式化

Phase 3: 权限审批
  - IM 模式下的权限拦截方案
  - IM 审批交互

Phase 4: 插件系统完善
  - 插件加载器
  - 配置体系
  - 更多 IM/CLI 插件
```

---

## 待定

- [ ] 会话持久化与 daemon 重启后的恢复策略
- [ ] IM 消息队列的持久化（daemon 重启时不丢消息）
- [ ] 测试策略
