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

- **终端**：直接运行 AI CLI 命令（如 `claude --resume <id>`），用户看到的就是原生 Claude Code，没有任何代理层
- **IM**：Daemon 为每个 session 维护一个**长驻**的 `claude -p --input-format stream-json --output-format stream-json` 进程，通过 stdin 写入消息、从 stdout 读取事件流；权限审批通过 `--permission-prompt-tool` 路由到 daemon MCP server（`can_use_tool`），由 daemon 异步返回 allow/deny
- **互斥**：同一 session 同一时刻只有一端在操作。终端在用时 IM 提示"会话正在终端使用中"

### 2.2 会话生命周期原则

- `mm-coder create <name>` 创建的是**命名会话元数据**，并分配稳定的 `sessionId`
- 首次 `attach` 或首次 IM 交互时，CLIPlugin 使用该 `sessionId` 初始化真实 AI CLI 会话
- 后续终端与 IM 都基于同一个 `sessionId` 继续 `--resume`
- `sessionId` 的分配由 CLIPlugin 决定；对 Claude Code，默认使用可持久化的 UUID
- daemon 只编排会话状态，不直接持有交互式终端进程的控制面

**IM 侧长驻进程管理规则：**

- daemon 为每个 session 维护一个 `claude -p --input-format stream-json` 长驻进程（IM worker）
- **懒启动**：daemon 启动时不主动重建 IM worker，等第一条 IM 消息到来时再 spawn（此时向 IM 发送"正在启动 Claude Code，请稍候"提示）
- **attach 退出后立即 pre-warm**：`mm-coder attach` 退出后 session 在语义上"仍在工作"，daemon 立即 spawn 新的 IM worker，无需等待 IM 消息触发
- **崩溃重启**：IM worker 非正常退出（exit code ≠ 0）时自动重启；采用退避间隔 `1s / 3s / 10s`，最大重试次数可配置（默认 3 次），超出后 session 进入 `error` 状态并通知 IM 用户
- **崩溃计数重置**：`imWorkerCrashCount` 仅在"成功处理一条完整 IM 消息"后清零（判定条件：收到对应消息的 `result` 事件并完成 IM 回传）；只要在消息处理中崩溃，不清零
- **context window 自管理**：Claude Code 内部自动压缩/摘要历史，API inputTokens 稳定在 ~68k 不随 session 累积增长；mm-coder 无需实现任何 context window 管理逻辑，IM worker 可长驻数千轮对话

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
    → mm-coder attach 本地 spawn claude 子进程，并通知 daemon 标记 session 为 attached（上报 direct child PID）
    → 若 session 处于 im_processing：
       → attach 界面显示"Claude Code 正在处理 IM 消息，等待完成..."
       → daemon 向 IM worker 发送 EOF/SIGTERM 信号前先等待当前消息完成
    → daemon 停止 IM worker 进程（SIGTERM，等待优雅退出）
    → 直接执行 claude --resume <id>（stdio: inherit）
    → 用户与 Claude Code 原生交互
    → Claude Code 退出后，通知 daemon（exit reason: normal 或 taken_over）
    → daemon 立即 pre-warm 新的 IM worker（spawn claude -p --input-format stream-json --resume <id>）
    → session 变为 idle，等待 IM 消息投递
    → 如果是被 IM 端接管导致退出，显示"会话已被 IM 端接管"

IM 交互:
  用户在 Mattermost thread 中发消息
    → IM Plugin 收到消息，根据 threadId 查找关联 session
    → Daemon 检查 session 状态
    → 如果 attached:
       → 在 thread 中提示"会话正在终端使用中，是否接管？"
       → 接管策略默认 **硬接管**（立即 SIGTERM）；可选策略 **软接管**（先通知终端并给 30s 宽限期，再 SIGTERM）
       → 用户选择接管 → session 进入 takeover_pending
       → Daemon 向终端 claude 进程发送 SIGTERM
       → Claude Code 优雅退出（session 状态自动保存）
       → session 变为 idle，继续处理 IM 消息
       → 用户选择不接管 → 消息排队等待
    → 如果 idle（IM worker 已在后台常驻）:
       → session 进入 im_processing
       → 通过 IM worker 的 stdin.write 投递消息（JSON 格式）
       → 从 IM worker stdout 流式读取 CLIEvent
       → 若出现权限审批请求（通过 permission-prompt-tool → daemon MCP server）:
          → session 进入 approval_pending
          → daemon 向 IM 发送带 requestId 的审批请求
          → 用户审批后，daemon MCP server 返回 allow/deny，session 回到 im_processing
       → 发送格式化结果到对应 thread
       → session 变回 idle，IM worker 保持存活等待下条消息
    → 如果 idle（IM worker 尚未启动，首条消息触发懒启动）:
       → 向 IM 回复"正在启动 Claude Code，请稍候..."
       → spawn IM worker：claude -p --input-format stream-json --output-format stream-json --verbose --resume <id>
       → 后续同 idle 流程
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

### 2.6 恢复原则

- daemon 重启后采用**保守恢复**：优先恢复 session 元数据，不自动重放不确定操作
- 无法确认的运行态进入 `recovering`，等待显式恢复或重新 attach
- 未决审批默认 fail-closed，不在后台无限等待
- `attached` / `im_processing` 等运行态恢复时必须结合 PID/进程存活校验纠偏
- **SIGTERM 接管**：daemon 向终端 Claude Code 发 SIGTERM 后进程干净退出（exit 143），session 完整可 resume；resume 后模型重新规划，不保留中断前 partial 状态知识，无数据损坏风险

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
  status: 'idle' | 'attach_pending' | 'attached' | 'im_processing' | 'approval_pending' | 'takeover_pending' | 'recovering' | 'error';
  lastExitReason?: 'normal' | 'taken_over' | 'cli_crash' | 'recovered';
  attachedPid: number | null;     // 终端 claude 进程 PID（attached 时有值）
  imWorkerPid: number | null;     // IM 侧长驻 claude -p 进程 PID（常驻，idle/im_processing 时均有值）
  imWorkerCrashCount: number;     // 连续崩溃计数，超出上限进入 error 状态
  imBindings: IMBinding[];        // 关联的 IM 线程
  messageQueue: QueuedMessage[];  // IM 待处理消息队列
  createdAt: Date;
  lastActivityAt: Date;
}

interface QueuedMessage {
  messageId: string;
  threadId: string;
  userId: string;
  content: string;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed';
  correlationId: string;
  enqueuePolicy: 'auto_after_detach' | 'manual_retry';
  restoreAction?: 'replay' | 'discard' | 'confirm';
  approvalState?: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
}

class SessionRegistry {
  create(name: string, opts: CreateOpts): Session;
  list(): SessionInfo[];
  remove(name: string): void;

  markAttached(name: string, pid: number): void;
  markDetached(name: string, reason?: Session['lastExitReason']): void;
  markImProcessing(name: string, pid: number): void;
  markRecovering(name: string): void;
  takeover(name: string): void;  // 向终端 claude 进程发 SIGTERM，强制释放 session

  bindIM(name: string, binding: IMBinding): void;
  getByIMThread(pluginName: string, threadId: string): Session | undefined;

  validateAttachedPid(name: string, expectedParentPid?: number): boolean;
  validateImWorkerPid(name: string): boolean;
}
```

### 3.3 IMWorkerManager

```typescript
class IMWorkerManager {
  spawn(session: Session): Promise<number>;              // 启动 claude -p 长驻进程，返回 pid
  terminate(name: string, signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  sendMessage(name: string, prompt: string): Promise<void>; // stdin.write(JSONL)
  isAlive(name: string): boolean;                        // process.kill(pid, 0)
  restartIfCrashed(name: string): Promise<void>;         // exit code ≠ 0 时触发
  resetCrashCountOnSuccess(name: string, correlationId: string): void;
}
```

职责：
- 管理每个 session 的 IM worker 子进程生命周期
- 维护 `imWorkerPid` 与 `imWorkerCrashCount`
- 处理懒启动 / pre-warm / 崩溃重启
- 仅在消息级成功（`result` 成功且回传 IM 完成）时调用 `resetCrashCountOnSuccess` 清零连续崩溃计数

### 3.4 ApprovalManager（daemon MCP server）

```typescript
interface ApprovalDecision {
  requestId: string;
  behavior: 'allow' | 'deny';
  reason?: string;
  scope?: 'once' | 'session';
}

class ApprovalManager {
  canUseTool(input: {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
  }): Promise<ApprovalDecision>;

  applyRules(toolName: string, toolInput: Record<string, unknown>): 'allow' | 'deny' | 'ask';
  requestIMApproval(session: Session, req: ApprovalRequest): Promise<ApprovalDecision>;
  invalidateStaleApproval(sessionId: string, requestId: string): void;
  expirePendingOnRestart(): Promise<void>; // pending -> expired (fail-closed)
}
```

职责：
- 在 daemon 内实现 MCP `can_use_tool` 处理逻辑
- 执行 autoAllow / autoDeny 规则匹配
- 路由 IM 审批并等待异步结果
- 维护审批状态机：`pending / approved / denied / expired / cancelled`
- 维护审批作用域：`once`（仅本次工具调用）与 `session`（当前会话后续同类工具调用）
- 每个审批请求使用全局唯一 `requestId`（`<sessionId>:<messageId>:<toolUseId>:<nonce>`），并在新请求到达时失效同会话旧 pending 请求

### 3.5 CLI 命令

```
mm-coder start                              启动 daemon
mm-coder stop                               停止 daemon
mm-coder create <name> [--workdir] [--cli]  注册新会话
mm-coder attach <name>                      直接启动 AI CLI 交互
mm-coder list                               列出所有会话
mm-coder remove <name>                      删除会话
mm-coder tui                                连接 daemon，实时监控面板
mm-coder status                             daemon 和会话状态
mm-coder import <session-id> [--name] [--workdir] [--cli]  导入外部 AI CLI 会话
```

### 3.6 Session 状态迁移规则

合法状态迁移：

| 当前状态 | 触发事件 | 目标状态 |
|----------|----------|----------|
| `idle` | `attach_start` | `attached` |
| `im_processing` | `attach_start` | `attach_pending` |
| `attach_pending` | `im_message_completed_and_worker_stopped` | `attached` |
| `attach_pending` | `attach_cancelled` | `idle` |
| `idle` | `im_message_received` | `im_processing` |
| `attached` | `attach_exit_normal` | `idle` |
| `attached` | `takeover_requested` | `takeover_pending` |
| `takeover_pending` | `terminal_sigterm_exited` | `idle` |
| `im_processing` | `tool_permission_required` | `approval_pending` |
| `approval_pending` | `approval_approved` | `im_processing` |
| `approval_pending` | `approval_denied` | `im_processing` |
| `approval_pending` | `approval_timeout_or_restart` | `idle` |
| `im_processing` | `message_completed` | `idle` |
| `im_processing` | `worker_crash` | `recovering` |
| `recovering` | `worker_restarted` | `idle` |
| `recovering` | `restart_failed_over_limit` | `error` |
| `error` | `manual_reset` | `idle` |

非法迁移处理：
- 任何未在上表声明的迁移都返回 `INVALID_STATE_TRANSITION` 错误
- daemon 记录审计日志并保持原状态不变
- IM/CLI 调用方收到可读错误：`Session state transition rejected: <from> -> <to>`

`attach_pending` 约束：
- session 进入 `attach_pending` 后，IM 入队仍可接收，但**禁止出队执行**（queue frozen）
- 仅允许当前 `im_processing` 中的那一条消息收尾
- 收尾后先停止 IM worker，再进入 `attached`，确保 attach 与 IM 执行无重叠窗口

状态字段与退出原因关系：
- `lastExitReason='taken_over'`：由 `takeover_pending -> idle` 写入
- `lastExitReason='cli_crash'`：attached 或 im_processing 进程异常退出写入
- `lastExitReason='normal'`：终端主动退出写入
- `lastExitReason='recovered'`：`recovering -> idle` 成功后写入

### 3.7 IPC 协议（Unix socket）

daemon 与 CLI/TUI 之间使用 **JSON Lines（每行一个 JSON）** 自定义协议。

请求：
```json
{"type":"request","requestId":"req-uuid","command":"create","args":{"name":"bug-fix","workdir":"/path"}}
```

成功响应：
```json
{"type":"response","requestId":"req-uuid","ok":true,"data":{"session":{"name":"bug-fix","status":"idle"}}}
```

错误响应：
```json
{"type":"response","requestId":"req-uuid","ok":false,"error":{"code":"SESSION_NOT_FOUND","message":"Session 'foo' not found","details":{}}}
```

错误码（字符串）：
- `INVALID_REQUEST`
- `UNKNOWN_COMMAND`
- `SESSION_ALREADY_EXISTS`
- `SESSION_NOT_FOUND`
- `INVALID_STATE_TRANSITION`
- `WORKER_NOT_RUNNING`
- `WORKER_SPAWN_FAILED`
- `APPROVAL_TIMEOUT`
- `INTERNAL_ERROR`

命令清单（IPC command）：
- `start`
- `stop`
- `status`
- `create`
- `list`
- `remove`
- `attach`
- `takeover`
- `open_thread`
- `import`

命令参数对齐（CLI ⇄ IPC）：
- `mm-coder create <name> [--workdir] [--cli]` ⇄ `{command:"create", args:{name, workdir?, cli?}}`
- `mm-coder attach <name>` ⇄ `{command:"attach", args:{name}}`
- `mm-coder takeover <name> [--mode hard|soft] [--grace-seconds 30]` ⇄ `{command:"takeover", args:{name, mode?, graceSeconds?}}`
- `mm-coder import <session-id> [--name] [--workdir] [--cli]` ⇄ `{command:"import", args:{sessionId, name?, workdir?, cli?}}`
- `mm-coder open <name>`（IM 快捷）⇄ `{command:"open_thread", args:{name}}`

keepalive（长连接客户端，如 TUI）：

客户端：
```json
{"type":"ping","ts":1713000000000}
```

daemon：
```json
{"type":"pong","ts":1713000000001}
```

规则：
- 客户端每 15s 发送 `ping`
- daemon 超过 45s 未收到 `ping` 可主动关闭连接
- CLI 短连接命令可不发送心跳

### 3.8 异常与恢复策略（Agent 运行时）

- `claude -p` 崩溃：进入 `recovering`，执行退避重启（1s/3s/10s）；超过次数阈值进入 `error`
- `claude -p` 单条消息超时：当前消息标记 `failed`，session 回到 `idle`，IM 回复"本条任务超时，请重试"（默认 `messageTimeoutSeconds=600`）
- API 限流（429）：遵循 CLI 原生重试/失败语义，daemon 不在 stdout 层做 429 文本解析与二次重试；若 worker 因 429 异常退出，按 `worker_crash` 路径处理
- 审批等待超时：`approval_pending` 最长等待 `permissionTimeoutSeconds`（默认 300 秒），超时后置 `expired` 并终止本轮工具调用
- daemon 重启恢复：
  - `pending approval` → `expired`（fail-closed）
  - `running message` → `confirm`（默认不自动重放）
  - `pending message` 默认 `replay`，但若消息含高风险工具审批上下文则降级为 `confirm`
- 对 AI agent 场景的要求：任何恢复动作都必须可审计（写入 correlationId、requestId、恢复动作、操作者）

### 3.9 排队消息与接管策略

- 终端 `attached` 期间收到 IM 消息时，默认入队并标记 `enqueuePolicy='auto_after_detach'`
- 会话被接管后，队列按 FIFO 自动继续处理
- daemon 重启后：
  - `restoreAction='replay'`：自动重放（仅无审批依赖的低风险消息）
  - `restoreAction='confirm'`：向 IM 用户发确认卡片后再执行
  - `restoreAction='discard'`：明确丢弃并记录审计日志
- 接管策略：
  - 默认 `hard`：立即 SIGTERM（用于 agent 持续执行优先场景）
  - 可选 `soft`：先通知终端并给予 `graceSeconds`（默认 30s），超时后强制 SIGTERM

### 3.10 核心类型定义（实现基线）

```typescript
/**
 * 流游标：记录上次成功处理的最后一个 assistant message ID（水位线）。
 *
 * 降级策略（ID 匹配不上时）：
 * - 正常情况：claude --resume 重放历史时每条 assistant 事件含稳定 messageId，
 *   parseStream 跳过 messageId ≤ cursor.lastMessageId 的历史事件。
 * - 匹配不上的场景：
 *   (a) 历史被 Claude Code 内部压缩摘要，旧 messageId 在重放流中消失；
 *   (b) cursor 来自更早的 session 版本，ID 格式不一致；
 *   (c) --resume 的 session 被 Claude Code 重置（极少见）。
 * - 降级行为（按顺序）：
 *   1. 收到 `system` 事件时，检测其 sessionId 是否与记录一致；
 *      若不一致，说明 session 被重置，清空 cursor，全量输出并记录审计日志。
 *   2. 若 sessionId 一致但扫描完全部历史事件后 lastMessageId 未出现，
 *      说明历史被压缩。采用 "安全丢弃" 策略：
 *      丢弃 `system` 事件之后、首个新 `result` 事件之前的所有历史输出（即上一轮结束的 result），
 *      仅将 result 之后的增量事件转发给 IMPlugin。
 *   3. 上述两种情况均写入 audit.log（action: stream_cursor_miss，details: reason）。
 */
interface StreamCursor {
  lastMessageId: string;    // 上次成功处理的最后一个 assistant messageId
  sessionId: string;        // 对应的 CLI session ID，用于检测 session 重置
}

type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'file'; name: string; mime: string; url: string };

interface MessageTarget {
  plugin: string;
  channelId?: string;
  threadId: string;
  userId?: string;
}

interface IncomingMessage {
  messageId: string;
  plugin: string;
  channelId?: string;
  threadId: string;
  userId: string;
  text: string;
  createdAt: string;
}

interface ApprovalRequest {
  requestId: string;
  sessionName: string;
  messageId: string;
  toolName: string;
  toolInputSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  scopeOptions: Array<'once' | 'session'>;
  timeoutSeconds: number;
}

interface ApprovalResult {
  requestId: string;
  decision: 'approved' | 'denied' | 'expired' | 'cancelled';
  scope: 'once' | 'session';
  operatorId?: string;
  decidedAt?: string;
  reason?: string;
}
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
  sendMessage(target: MessageTarget, content: MessageContent): Promise<void>;
  updateMessage(target: MessageTarget, messageId: string, content: MessageContent): Promise<void>;

  // 为流式输出创建可增量更新的消息句柄（用于 token/event 防抖合并）
  createLiveMessage(target: MessageTarget): Promise<{ messageId: string }>;

  // 为新 session 创建独立 thread，返回 threadId
  createThread(channelId: string, sessionName: string): Promise<string>;

  // 权限审批
  requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<ApprovalResult>;
}
```

- `updateMessage` 用于流式增量更新，建议默认防抖窗口 500ms（插件可配置）
- `createLiveMessage` 在首个 assistant 事件前创建占位消息，后续统一走同一 messageId 更新，避免 IM 刷屏

### 4.2 CLI Plugin 接口

```typescript
interface CLIEvent {
  // 基于 stream-json 实测事件类型
  type: 'system' | 'assistant' | 'user' | 'result' | 'attachment' | 'last-prompt' | 'queue-operation';
  // system/init: session 初始化信息，含 session_id、tools、permissionMode 等
  // assistant: 含 message.content（text/thinking/tool_use blocks）
  // user: 含 message.content（tool_result blocks），tool_result.content 为字符串
  // result: 含 subtype（success/error）、is_error、result 文本
  // attachment/last-prompt/queue-operation: v2.0.76 新增，parseStream 需兼容未知 type
  payload: Record<string, unknown>;
}

interface CLIPlugin {
  name: string;

  // 终端模式：构建交互式启动命令
  buildAttachCommand(session: Session): { command: string; args: string[] };

  // IM 模式：构建长驻 IM worker 启动命令
  buildIMWorkerCommand(session: Session): { command: string; args: string[] };

  // sessionId 的生成/初始化
  generateSessionId(): string;

  // 验证 session 是否可继续 resume
  validateSession(sessionId: string): Promise<boolean>;

  parseStream(stdout: NodeJS.ReadableStream, cursor?: StreamCursor): AsyncIterable<CLIEvent>;

  // 权限拦截：Claude Code 用 daemon MCP server 实现（见第 5 节）
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

  // 终端 attach：直接 spawn 交互式进程（stdio: inherit）
  buildAttachCommand(session: Session) {
    return {
      command: 'claude',
      args: ['--resume', session.sessionId],
    };
  }

  // IM worker：长驻非交互进程，通过 stdin 持续投递消息
  buildIMWorkerCommand(session: Session) {
    return {
      command: 'claude',
      args: ['-p', '--resume', session.sessionId,
             '--input-format', 'stream-json',
             '--output-format', 'stream-json', '--verbose'],
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

### MCP Bridge 通信拓扑（Claude Code 场景）

Daemon 是常驻进程，Claude Code 的 `--permission-prompt-tool` 要求一个**以 stdio 通信的 MCP server**（子进程方式）。为避免额外进程，采用 **Stdio↔Socket Bridge** 方案：

```text
Daemon 启动时：
  → 在 Unix socket（~/.config/mm-coder/mcp-bridge.sock）上监听 MCP 协议

spawn IM worker 时：
  → 动态生成临时 bridge 脚本（mcp-bridge.js）：
      连接 mcp-bridge.sock，双向转发 stdin↔socket
  → 以 stdio 子进程方式传给 claude：
      --permission-prompt-tool "node /tmp/mm-coder-mcp-bridge-<sessionId>.js"

通信链路：
  claude -p --permission-prompt-tool → mcp-bridge.js (stdio) → daemon (Unix socket)
```

**关键实现要点：**
- bridge 脚本启动时附带 `sessionId` 参数，daemon 据此路由到对应 `ApprovalManager`
- bridge 脚本随 IM worker 生命周期绑定，worker 退出后 bridge 脚本也同步退出
- bridge socket 文件权限 `0600`，与 IPC socket 同等安全级别
- bridge 脚本为纯转发层，不含业务逻辑，所有审批判断在 daemon 侧执行

### 设计原则

权限拦截由 CLIPlugin 各自实现，优先使用每个 CLI 的原生机制，而不是统一抽象成跨 CLI 的 MCP Permission Server。

| CLI | 原生机制 | 适用性 |
|-----|---------|--------|
| Claude Code | `--permission-prompt-tool` + daemon MCP server | 已定版：仅用 MCP 方案，PreToolUse 不引入 |
| Codex CLI | Approval Mode / 内置安全模式 | 应复用 Codex 自带审批能力 |
| Gemini CLI | Policy Engine（声明式规则） | 应注入规则，而不是外围劫持 |

**为什么 MCP 不设计成跨 CLI 统一审批层：**
- MCP 是 Claude Code 场景的**实现载体**，不是跨 CLI 的统一抽象
- Codex / Gemini 各自有更原生的审批机制（Approval Mode / Policy Engine），不应被强制统一到 MCP
- mm-coder 上层维护统一的审批状态机（`pending / approved / denied / expired / cancelled`），底层由各 CLI plugin 接入自己的原生机制
- MCP 在 Claude Code 场景下同时承担 permission prompt 和未来扩展模型工具能力的职责

### 终端模式

直接使用 AI CLI 原生审批（Claude Code 自带的终端权限确认），无需干预。

### IM 模式（以 Claude Code 为例）

Claude Code IM 审批已选定方案（Spike 定版）：

#### 选定方案：`--permission-prompt-tool` + daemon MCP server

```text
claude -p 执行中，要调用 Write 工具
  → Claude Code 调用 permission prompt tool (mm-coder-permission)
  → mm-coder daemon 的 MCP server 收到 can_use_tool 请求
  → daemon 在 IM thread 中发审批消息
  → 用户批准或拒绝
  → MCP server 返回 allow/deny 给 Claude Code
  → Claude Code 执行或拒绝工具
```

daemon MCP server 通过 Unix socket 与 IM worker 通信，实现本地审批路由，无需单独进程。

**结论（Spike 定版）：**
- Claude Code IM 审批：**仅采用 PermissionRequest（MCP）机制**
  - daemon 充当 MCP server，实现 `can_use_tool` tool
  - IM worker 通过 `--permission-prompt-tool mm-coder-permission` 连接 daemon MCP server
  - `sendRequest` 返回 Promise，天然支持 IM 用户异步审批
  - autoAllow/autoDeny 在 daemon MCP server 层做规则匹配，命中则同步返回，无需打扰用户
- Claude Code 终端模式：直接使用 Claude Code 原生权限确认，无需干预
- Codex / Gemini：各自复用原生机制（Approval Mode / Policy Engine），不在 mm-coder 范围内统一抽象
- **PreToolUse Hook 不引入**：它无法等待 IM 异步响应，且与 PermissionRequest 存在职责重叠，引入会增加状态机复杂度；如需在终端模式本地过滤危险命令，可在全局 Claude Code settings 中单独配置，不在 mm-coder 项目范围内

**配置（挂在 CLI 插件下，非全局）：**

```yaml
plugins:
  cli:
    - name: claude-code
      package: "@mm-coder/plugin-claude-code"
      permissions:
        # 规则按 capability+riskLevel 生效，字符串仅兜底
        autoAllowCapabilities: [read_only]
        autoAskCapabilities: [file_write]
        autoDenyCapabilities: [shell_dangerous, network_destructive]
        autoDenyPatterns: ["Bash:rm -rf", "Bash:drop", "Bash:truncate"]
        timeout: 300
```

**实现要点：**

- `strategy` 配置仅保留 `mcp_prompt_tool`（实际固定为此值），删除 `auto` 和 `pre_tool_use_hook` 候选
- `autoAllowCapabilities` / `autoAskCapabilities` / `autoDenyCapabilities` 在 daemon MCP server 层实现，命中能力策略时同步返回；`autoDenyPatterns` 仅作兜底
- daemon 维护 pending approval 状态机（`pending / approved / denied / expired / cancelled`）
- IM 用户审批后，daemon 的 MCP server 立即通过 `sendRequest` 响应返回给 Claude Code
- daemon 重启后未决审批默认 `expired`（fail-closed），由用户显式重试

---

## 6. 安全与授权模型

- 每个 session 维护独立 ACL（`session_acl`），按 `plugin + userId` 识别主体
- 最少三类角色：
  - `operator`：可发送会话消息
  - `approver`：可审批工具执行
  - `owner`：可接管终端会话、修改 ACL、删除/归档 session
- 默认授权策略（fail-closed）：未命中 ACL 的用户只能查看只读状态，不可投递消息或审批

审批交互协议：
- `requestId` 生成规则：`<sessionId>:<messageId>:<toolUseId>:<nonce>`
- 用户动作：`approve | deny | cancel`
- scope：`once | session`
- 旧审批失效：同一 session 新审批产生后，所有旧 `pending` 请求自动置 `cancelled`
- 超时策略：超过 `permissionTimeoutSeconds`（默认 300，需低于 Claude API 长连接超时 ~600s）未决 → `expired`

`autoAllow/autoDeny` 风险策略：
- 字符串匹配仅作为兜底，不作为主策略
- 主策略使用 `capability + riskLevel`：
  - 低风险（`read_only`）可 autoAllow
  - 中风险（`file_write`）默认 ask
  - 高风险（`shell_dangerous` / `network_destructive`）autoDeny

日志与审计策略（Agent 可观测性）：
- 日志级别：`debug | info | warn | error`
- 输出位置：
  - 运行日志：`~/.config/mm-coder/logs/daemon.log`
  - 审计日志：`~/.config/mm-coder/logs/audit.log`
- 关键审计事件：审批动作、接管动作、session 删除/归档、危险工具调用、恢复动作
- 每条审计日志必须包含：`timestamp`、`sessionId`、`correlationId`、`requestId`（如有）、`operatorId`（如有）、`action`、`result`

本地 IPC（Unix socket）安全：
- socket 文件权限固定为 `0600`，目录为 `0700`
- 仅允许同 UID 进程连接；若检测到 UID 不一致，立即拒绝并审计

---

## 7. IM 交互

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

## 8. 配置

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
        # 规则按 capability+riskLevel 生效，字符串仅兜底
        autoAllowCapabilities: [read_only]
        autoAskCapabilities: [file_write]
        autoDenyCapabilities: [shell_dangerous, network_destructive]
        autoDenyPatterns: ["Bash:rm -rf", "Bash:drop", "Bash:truncate"]
        timeout: 300

defaults:
  cli: claude-code
  workdir: ~/projects

limits:
  maxSessions: 8
  sessionTimeoutMinutes: 60
  permissionTimeoutSeconds: 300

retention:
  sessionMetadataDays: 7
  auditLogDays: 30
  sessionArchiveDays: 14

persistence:
  path: ~/.config/mm-coder/sessions.json

ipc:
  socketPath: ~/.config/mm-coder/daemon.sock

ui:
  defaultMode: headless  # headless | tui
```

---

## 9. 运行模式

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

### Session 生命周期与清理

- 运行中 session 仅支持手动删除，不做自动清理
- `idle` 且超过 `sessionTimeoutMinutes` 的 session 标记为 `stale`（不删除）
- `stale` 且超过 `retention.sessionArchiveDays` 的 session 自动归档（保留元数据与审计日志，移除活跃队列）
- 超出 `limits.maxSessions` 时，禁止创建新 session，并提示先清理或归档

---

## 10. 项目结构

```
src/
├── index.ts                 # CLI 入口（命令解析）
├── daemon.ts                # Daemon 主进程
├── session-registry.ts      # Session 注册表
├── im-worker-manager.ts     # IM worker 生命周期管理
├── approval-manager.ts      # MCP permission 审批管理
│
├── plugins/
│   ├── types.ts             # 插件接口定义
│   ├── plugin-host.ts       # 插件加载器
│   ├── im/
│   │   └── mattermost.ts
│   └── cli/
│       └── claude-code.ts
│
├── ipc/
│   └── socket-server.ts     # Unix socket IPC
│
├── config/
│   └── index.ts
│
└── utils/
    └── logger.ts
```

---

## 11. 实现顺序

```
Phase 1: 核心骨架
  - Daemon + IPC 通信
  - SessionRegistry
  - CLI 命令（start/create/attach/list）
  - Claude Code 插件（attach + IM worker 命令构建）

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

详见 `docs/TODO.md`（单一待办来源，避免与 SPEC 重复维护）。
