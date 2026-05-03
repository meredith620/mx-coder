-# mx-coder (Multi-modal Coder) — 需求与设计规格

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
$ mx-coder start                                # 启动 daemon（一次性）
$ mx-coder create bug-fix --workdir ~/myapp     # 注册一个命名会话

# 在电脑前：终端直接交互
$ mx-coder attach bug-fix                       # 直接启动 Claude Code，原生体验
  ... 正常使用 Claude Code ...
  /exit 或 Ctrl+C                               # 退出 Claude Code = 释放会话

# 离开电脑：IM 远程交互
  → Mattermost 上发消息继续推进任务
  → 权限请求通过 IM emoji/按钮审批

# 回到电脑：终端再次接续
$ mx-coder attach bug-fix                       # 再次启动 Claude Code，自动 resume
```

---

## 2. 架构

### 2.1 核心思路：Session-based 混合方案

终端和 IM 使用不同的交互通道访问同一个 AI CLI 会话：

- **终端**：直接运行 AI CLI 命令（如 `claude --resume <id>` 或 `claude --session-id <id>`），用户看到的就是原生 Claude Code，没有任何代理层
- **IM**：Daemon 为每个活跃 session 维护一个常驻 `claude -p --input-format stream-json --output-format stream-json --verbose` 进程。每条 IM 消息先入 session 队列，再按 FIFO 串行写入同一个 worker 的 stdin
- **互斥**：同一 session 同一时刻只允许一个控制端。终端 attach 时，IM 普通消息直接拒绝；用户可通过 takeover 请求或强制接管
- **版本信息**：build 时写入静态版本与 git hash，运行时不执行 git 命令

### 2.2 会话生命周期原则

- `mx-coder create <name>` 创建的是**命名会话元数据**，并分配稳定的 `sessionId`
- 首次 `attach` 或首次 IM 交互时，CLIPlugin 使用该 `sessionId` 初始化真实 AI CLI 会话
- 后续终端与 IM 都基于同一个 `sessionId` 继续 `--resume`
- `sessionId` 的分配由 CLIPlugin 决定；对 Claude Code，默认使用可持久化的 UUID
- daemon 只编排会话状态，不直接持有交互式终端进程的控制面

**IM 侧长驻进程管理规则：**

- daemon 为每个活跃 session 维护一个 `claude -p --input-format stream-json` 长驻进程（IM worker）
- **懒启动**：daemon 启动时不主动重建 IM worker；当某个 session 第一次收到 IM 消息，或 attach 退出需要回到 IM 模式时，再启动该 session 的 worker
- **常驻串行消费**：worker 启动后保持存活；同一 session 的后续 IM 消息进入 `messageQueue`，并按 FIFO 串行写入同一个 worker 的 stdin，不再为每条消息重新 spawn Claude 进程
- **attach 退出后立即 pre-warm**：`mx-coder attach` 退出后，daemon 立即为该 session 启动或恢复 IM worker，使后续 IM 消息可直接复用现有上下文
- **attach 接管时停止 worker**：终端 attach 获得控制权前，daemon 必须先停止该 session 的 IM worker，确保 attach 与 IM worker 不会同时驱动同一 Claude 会话
- **崩溃重启**：IM worker 非正常退出（exit code ≠ 0）时自动重启；采用退避间隔 `1s / 3s / 10s`，最大重试次数可配置（默认 3 次），超出后 session 进入 `error` 状态并通知 IM 用户
- **崩溃计数重置**：`imWorkerCrashCount` 仅在“成功处理一条完整 IM 消息并完成 IM 回传”后清零；只要在处理中崩溃，不清零
- **context window 自管理**：Claude Code 内部自动压缩/摘要历史，mx-coder 不额外做 context 管理；常驻 worker 直接复用同一 Claude 会话上下文

```
                    ┌──────────────────────────────────────┐
                    │           mx-coder daemon             │
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
    │ mx-coder CLI │   │ Mattermost   │   │ AI CLI       │
    │ (用户命令)    │   │ (IM 消息)    │   │ (非交互进程)  │
    └──────────────┘   └──────────────┘   └──────────────┘
```

### 2.3 数据流

```
终端 attach:
  mx-coder attach bug-fix
    → mx-coder attach 本地 spawn claude 子进程，并通知 daemon 标记 session 为 attached（上报 direct child PID）
    → 若 session 的 IM worker 正在处理消息或等待审批：
       → attach 界面显示“Claude Code 正在处理 IM 消息，等待安全切换...”
       → CLI 保持 IPC 连接，等待 daemon 推送 `attach_ready` event
       → daemon 允许当前消息完成、必要时等待审批结束，然后停止 IM worker
       → daemon 向等待中的 CLI 发送 `{type:"event",event:"attach_ready",data:{name}}`
       → CLI 收到 attach_ready 后继续执行 attach 流程
    → 若 session 的 IM worker 仅处于 ready/idle：
       → daemon 直接停止该 worker，再将控制权切给终端 attach
    → 直接执行 claude --resume <id>（stdio: inherit）
    → 用户与 Claude Code 原生交互
    → 用户输入 `/exit` 或按 `Ctrl+C` 结束 attach
    → attach 进程总是上报 detach（`markDetached`），daemon 立即释放会话互斥锁
    → Claude Code 退出后，通知 daemon（exit reason: normal 或 taken_over）
    → daemon 立即 pre-warm IM worker（spawn claude -p --input-format stream-json --resume <id> --permission-prompt-tool "node /tmp/mx-coder-mcp-bridge-<id>.js"）
    → session 回到可供 IM 复用的 worker-ready 状态
    → 如果是被 IM 端接管导致退出，显示“会话已被 IM 端接管”

IM 交互:
  用户在 Mattermost thread 中发消息
    → IM Plugin 收到消息，根据 threadId 查找关联 session
    → Daemon 检查 session 状态
    → 如果 attached:
       → 普通文本消息直接拒绝，不入队，并提示 `/takeover <name>`
       → 用户执行 `/takeover <name>` → session 进入 takeover_pending，等待终端释放
       → 用户执行 `/takeover-force <name>` → daemon 终止终端 attach 对应 claude 进程，session 立即释放给 IM
       → 终端也可执行 `mx-coder takeover-cancel <name>` 取消接管请求
    → 如果 session 可由 IM 控制:
       → 消息先入 `messageQueue`
       → 若 worker 尚未启动，则懒启动该 session 的常驻 Claude worker
       → daemon 取队首消息写入 worker stdin
       → worker stdout 事件流持续回传到对应 thread
       → 当前消息处理期间 session 进入 `im_processing`
       → 若出现权限审批请求：session 进入 `approval_pending`，同一个 worker 在该工具调用点阻塞等待 IM 审批结果
       → 当前消息完成后，worker 不退出；session 回到 worker-ready 状态，继续等待下一条 IM 消息
```

### 2.5 原生 CLI 命令穿透 (Native Passthrough)

为支持不同底层 Coder CLI 的原生特有命令（如 Claude Code 的 `/effort`, Gemini 的 `/model`），定义穿透语法：

- **语法**：`//<command>` （以双斜杠开头）
- **路由逻辑**：
  - IM Worker 识别到 `//` 前缀。
  - 剥离首个 `/`，将剩余部分（保留一个 `/`）作为标准输入发送给底层 Coder CLI。
  - 例如：IM 输入 `//compact` -> Coder CLI 接收到 `/compact`。
- **权限**：穿透命令视同 `shell_dangerous` 级别，必须由具有 `operator` 权限的用户发起。
- **冲突处理**：以单斜杠 `/` 开头的命令（如 `/status`）始终优先解析为 mx-coder 控制命令。

### 2.6 IM 消息路由与会话空间策略

```
Channel 主消息流 → 信息/导航命令（/help, /list, /status, /open）+ 顶层普通文本
  /list   → 列出所有 session 及其绑定位置（thread 或 channel）
  /open   → 根据当前 Mattermost `spaceStrategy` 为目标 session 创建或定位对应的会话空间
  普通文本 → 以当前上下文自动创建/命中一个 IM 会话（`im-*`），其空间类型由当前 `spaceStrategy` 决定

Thread 模式（默认）
  /open   → 若目标 session 未绑定 thread，则创建新的独立 thread 并绑定；若已绑定，则在目标 thread 发定位消息
  threadId → SessionRegistry.getByIMThread() → 对应 session
  普通文本直接路由到关联 session；若该 thread 尚未绑定，则自动创建一个 thread 级 IM 会话

Channel 模式（Mattermost 可选）
  /open   → 若目标 session 未绑定 channel，则创建新的独立 **private channel** 并绑定；若已绑定，则向当前上下文回复并在目标 channel 发定位消息
  channelId / conversation binding → 对应 session
  普通文本若落在当前 bot 管理的 session channel 中，则直接路由到对应 session；若当前上下文尚未绑定，则自动创建一个 channel 级 IM 会话
```

设计约束：
- `spaceStrategy` 当前仅对 Mattermost 生效；默认值为 `thread`
- `channel` 是 Mattermost 的可选会话空间策略，不是对 `thread` 的直接替代
- `spaceStrategy` 是**创建时策略**：修改配置后，仅影响未来新建的 session；既有 session 保持原绑定方式，不自动迁移
- CLI / TUI 可在单次创建或 open 动作中 override 全局默认策略，但 override 只影响本次创建，不回写全局默认值
- `channel` 模式默认创建 **private channel**
- 主 channel 作为统一索引入口保留，用于 `/help`、`/list`、`/status`、`/open` 与顶层普通文本入口
- `channel` 模式下，session 清理默认优先 archive/解绑语义，而不是硬删除 channel

### 2.6 本次迁移的设计收敛结论

- **结论 1：IM 改为单 session 单常驻 Claude worker。** 消息完成边界以输出流中的 `result` 事件为准，不再以子进程退出为准。
- **结论 2：`status` 与 `runtimeState` 分离。** `status` 继续表达控制权与流程迁移；`runtimeState` 表达 worker 冷/热、运行、审批阻塞、恢复中等运行语义。
- **结论 3：attach/takeover 的本质是控制权切换，不是简单状态翻转。** 切换前必须先停掉另一侧对应进程，禁止终端 attach 与 IM worker 并发驱动同一 Claude session。
- **结论 4：`approval_pending` 属于“当前常驻 worker 正在执行的一条消息”的阻塞子状态。** 它必须绑定正在运行的消息与 worker，而不是独立于 worker 存在。
- **结论 5：`messageQueue` 负责调度，不负责承载进程生命周期。** 队列只描述消息排队、恢复、重放和幂等，不再隐含“一条消息一次 spawn”。
- **结论 6：daemon 重启后不恢复旧 worker 进程。** 统一把会话带回 `cold`/恢复路径，再按懒启动或 attach 重新建立可靠控制面。
- **结论 7：Mattermost WebSocket 需要应用层活性检测。** 不能只依赖底层 TCP 或 WebSocket 对象存活；必须引入 heartbeat/ack/lastMessageAt 窗口，识别“连接表面存活但订阅逻辑已断”的半断链。
- **结论 8：typing indicator 是 busy/idle 派生行为，不是 Claude 原生状态。** 仅当某个 session 处于 `runtimeState=running` 且 IM 插件支持时，才按节流发送 typing。

### 2.7 Mattermost 配置加载与连接验证

- 配置文件默认路径：`~/.mx-coder/config.json`
- 仅支持一种 JSON 结构：`{ "im": { "mattermost": { ... } } }`
- 必填字段：`url` / `token` / `channelId`，缺失或空字符串立即报错并拒绝启动插件
- 可选字段：
  - `reconnectIntervalMs`（>0，默认 5000ms）
  - `spaceStrategy`：`thread | channel`，默认 `thread`，当前仅对 Mattermost 生效
  - `teamId`：当 `spaceStrategy=channel` 时必填，用于创建未来 session 的独立 channel
- `spaceStrategy` 是未来创建策略：修改配置后，仅影响之后新建的 session；已存在 session 不迁移
- 连接验证闭环：
  - `connect()` 首先调用 `GET /api/v4/users/me` 校验 token
  - 校验通过后启动 `wss://.../api/v4/websocket`
  - WebSocket `open` 后发送 `authentication_challenge`
  - 仅处理 `posted` 事件，且要求 `channel_id === config.channelId` 或属于当前 bot 管理的 session channel
  - 忽略 bot 自己发送的消息（`post.user_id === botUserId`）
- **连接健壮性要求（新增）**：
  - 不得仅依赖底层 TCP 存活判定 WebSocket 可用；必须维护应用层活性信号
  - 插件需维护 `lastWsMessageAt` / `lastWsHeartbeatAckAt` 等时间戳，并以心跳窗口检测“TCP 已恢复但 WebSocket 逻辑失活”的半断链场景
  - 当超过活性窗口未收到 WS 消息或 heartbeat ack 时，必须主动关闭当前 WebSocket 并重建，而不是无限等待底层 socket 自愈
  - REST 可用性与 WS 订阅活性分开判断；REST 正常不代表 WS 正常
- 失败语义：任一 REST 调用非 2xx 立即抛错（携带 status + body），调用方可直接感知不可用配置


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
  sessionEnv: Record<string, string>;  // per-session 环境变量，持久化存储，attach / IM worker spawn 时注入 process.env

  // 控制面状态（短期、高频变更）
  status: 'idle' | 'attach_pending' | 'attached' | 'im_processing' | 'approval_pending' | 'takeover_pending' | 'error';

  // 生命周期态（长期、低频变更）
  lifecycleStatus: 'active' | 'stale' | 'archived';

  // 初始化态（首次 attach/IM 懒初始化闭环）
  initState: 'uninitialized' | 'initializing' | 'initialized' | 'init_failed';

  // 运行态：用于表达 worker 是否冷启动、已就绪、执行中、审批中等语义
  runtimeState: 'cold' | 'ready' | 'running' | 'waiting_approval' | 'attached_terminal' | 'takeover_pending' | 'recovering' | 'error';

  // 并发控制
  revision: number;                // 每次状态变更 +1，用于 CAS
  spawnGeneration: number;         // 每次尝试启动/重建 IM worker +1，防止 pre-warm/lazy spawn/重启并发双启动

  lastExitReason?: 'normal' | 'taken_over' | 'cli_crash' | 'recovered';
  attachedPid: number | null;      // 终端 claude 进程 PID（attached 时有值）
  imWorkerPid: number | null;      // IM 侧常驻 claude -p 进程 PID（worker ready/running/approval_pending 时均可能有值）
  imWorkerCrashCount: number;      // 连续崩溃计数，超出上限进入 error 状态
  streamVisibility: 'normal' | 'thinking' | 'verbose'; // IM 输出可见性
  imBindings: IMBinding[];         // 关联的 IM 线程
  messageQueue: QueuedMessage[];   // IM 待处理消息队列；只负责入队/恢复/重放/串行调度，不再等同“一条消息一个进程”
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

  // 幂等去重键：<plugin>:<threadId>:<messageId>
  dedupeKey: string;

  enqueuePolicy: 'auto_after_detach' | 'manual_retry';
  restoreAction?: 'replay' | 'discard' | 'confirm';
  replayOf?: string; // 若为 replay，指向原消息 dedupeKey
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
  requestTakeover(name: string, requestedBy?: string): void;
  cancelTakeover(name: string): void;
  completeTakeover(name: string): void;

  bindIM(name: string, binding: IMBinding): void;
  getByIMThread(pluginName: string, threadId: string): Session | undefined;
}
```

### 3.3 IMWorkerManager

```typescript
class IMWorkerManager {
  spawn(session: Session): Promise<number>;                    // 启动 claude -p 长驻进程，返回 pid
  terminate(name: string, signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  ensureRunning(name: string): Promise<void>;                 // 确保该 session 已有可写入的常驻 worker
  sendMessage(name: string, prompt: string): Promise<void>;   // stdin.write(JSONL)
  isAlive(name: string): boolean;                             // process.kill(pid, 0)
  restartIfCrashed(name: string): Promise<void>;              // exit code ≠ 0 时触发
  resetCrashCountOnSuccess(name: string, correlationId: string): void;
}
```

职责：
- 管理每个 session 的 IM worker 子进程生命周期
- 维护 `imWorkerPid`、`spawnGeneration` 与 `imWorkerCrashCount`
- 处理懒启动 / pre-warm / attach 前停 worker / 崩溃重启
- 对外暴露“确保 worker 可复用”和“向当前 worker 写入一条消息”两个能力，而不是“每条消息新起一个 Claude 进程”
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
    messageId: string;
    correlationId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    capability: 'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive';
    operatorId: string;
  }): Promise<ApprovalDecision>;

  applyRules(toolName: string, toolInput: Record<string, unknown>, capability: 'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive'): 'allow' | 'deny' | 'ask';
  requestIMApproval(session: Session, req: ApprovalRequest): Promise<ApprovalDecision>;
  invalidateStaleApproval(sessionId: string, requestId: string): void;
  expirePendingOnRestart(): Promise<void>; // pending -> expired (fail-closed)
}
```

审批关联上下文：

```typescript
interface ApprovalContext {
  sessionId: string;
  sessionName: string;
  messageId: string;
  correlationId: string;
  toolUseId: string;
  toolName: string;
  capability: 'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive';
  operatorId: string;
  requestId: string;
}
```

职责：
- 在 daemon 内实现 MCP `can_use_tool` 处理逻辑
- 执行 autoAllow / autoDeny 规则匹配
- 路由 IM 审批并等待异步结果
- 维护审批状态机：`pending / approved / denied / expired / cancelled`
- 维护审批作用域：`once`（仅本次工具调用）与 `session`（当前会话后续同类工具调用）
- 每个审批请求使用全局唯一 `requestId`（`<sessionId>:<messageId>:<toolUseId>:<nonce>`），并在新请求到达时失效同会话旧 pending 请求

审批并发仲裁规则：
- 同一 session 任一时刻仅允许一个 pending 审批请求。
- 并发审批回调采用 first-write-wins：第一个有效决策生效，其余决策标记 `cancelled` 并审计。
- 回调 requestId 与当前 pending 不匹配时，必须视为 stale 并丢弃（不改变状态）。
- `expired` / `cancelled` 必须映射为 deny 返回给 CLI（fail-closed）。
- `scope='session'` 的授权缓存键固定为：`sessionId + operatorId + capability`（用户定版）。
- 会话结束、接管完成、manual_reset、session 删除时，必须清空该 session 的 scope 缓存。

### 3.5 CLI 命令

```
mx-coder start                              启动 daemon
mx-coder stop                               停止 daemon
mx-coder create <name> [--workdir] [--cli]  注册新会话
mx-coder attach <name>                      直接启动 AI CLI 交互
mx-coder list                               列出所有会话
mx-coder remove <name>                      删除会话
mx-coder tui                                连接 daemon，实时监控面板（subscribe 长连接 + 循环重绘 + SIGINT/SIGTERM 退出）
mx-coder status                             daemon 和会话状态
mx-coder import <session-id> [--name] [--workdir] [--cli]  导入外部 AI CLI 会话
mx-coder env get <session>                  获取 session 所有环境变量（脱敏）
mx-coder env set <session> <KEY> <VALUE>    设置 session 环境变量
mx-coder env unset <session> <KEY>          删除 session 单个环境变量
mx-coder env clear <session>                清空 session 所有环境变量
mx-coder env import <session> <env-file>    从本地 env 文件批量导入（安全解析，禁止 shell eval）
mx-coder env list <session>                 列出 session 所有环境变量 key + 脱敏 value
```

#### 3.5.1 `mx-coder remove <name>` 语义

- `remove` 的目标是同时清理 **控制面 registry** 与 **该 session 关联的 IM worker 进程**；禁止只删 registry 而遗留 OS 层 Claude worker。
- `idle + cold`：允许 remove，直接删除 session 元数据。
- `idle + ready`：允许 remove，但若存在 `imWorkerPid`，必须先 terminate worker，再删除 session 元数据。
- `attached` / `attach_pending` / `takeover_pending`：默认拒绝 remove，返回 `INVALID_STATE_TRANSITION`。
- 拒绝 remove attached session 的原因是：attach 代表终端控制端仍持有会话；remove 不应静默删 registry 后放任 attach Claude 继续运行。
- 若未来引入 force remove，必须作为显式独立语义设计；当前默认 remove 不包含 force 行为。

### 3.6 Session 状态迁移规则

合法状态迁移：

| 当前状态 | 触发事件 | 目标状态 |
|----------|----------|----------|
| `idle` | `attach_start` | `attached` |
| `im_processing` | `attach_start` | `attach_pending` |
| `approval_pending` | `attach_start` | `attach_pending` |
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
| `im_processing` | `worker_crash` | `im_processing` + `runtimeState=recovering` |
| `approval_pending` | `worker_crash` | `approval_pending` + `runtimeState=recovering` |
| `runtimeState=recovering` | `worker_restarted` | 稳定控制面状态（通常 `idle`） |
| `runtimeState=recovering` | `restart_failed_over_limit` | `error` |
| `error` | `manual_reset` | `idle` |

非法迁移处理：
- 任何未在上表声明的迁移都返回 `INVALID_STATE_TRANSITION` 错误
- daemon 记录审计日志并保持原状态不变
- IM/CLI 调用方收到可读错误：`Session state transition rejected: <from> -> <to>`

`attach_pending` 约束：
- session 进入 `attach_pending` 后，IM 入队仍可接收，但**禁止出队执行**（queue frozen）
- 若当前 worker 正在处理消息，只允许该消息自然收尾；若当前 worker 仅处于 ready 态，则应立即停止 worker，直接进入 attach
- 若当前 worker 处于 `approval_pending`，attach 不得与审批并发；必须先完成或取消该审批，再切换到终端
- 进入 `attached` 前必须保证该 session 没有活跃 IM worker，确保 attach 与 IM 执行无重叠窗口

状态字段与退出原因关系：
- `lastExitReason='taken_over'`：由 `takeover_pending -> idle` 写入
- `lastExitReason='cli_crash'`：attached、im_processing 或 approval_pending 对应进程异常退出写入
- `lastExitReason='normal'`：终端主动退出写入
- `lastExitReason='recovered'`：运行时恢复完成并回到稳定控制面状态后写入

### 3.6.1 并发原子性与竞态裁决（实现强约束）

会话级原子约束：
- 同一 session 的状态迁移、队列出入队、worker 启停、副作用写入必须在“单会话互斥锁”内完成。
- 每次提交都必须校验 `revision`（CAS）。校验失败返回 `SESSION_BUSY`，并且不得产生任何部分副作用。
- 锁内提交成功后 `revision += 1`。

并发到达裁决（用户定版）：
- `idle` 下 `attach_start` 与 `im_message_received` 几乎同时到达时，**attach 优先**；IM 消息仅入队，不得立即出队执行。
- `attach_pending` 期间队列保持 frozen：可入队、不可出队。
- `approval_pending` 期间若收到 takeover，请先将当前审批置 `cancelled`，再进入 `takeover_pending`。
- `approval_pending` 期间若收到 attach，请进入 `attach_pending`，但必须等审批结束或被取消、worker 停止后才能真正 attach。

IM worker 唯一性约束：
- `pre-warm` 与 `lazy spawn` 必须通过 `spawnGeneration` 去重；任一时刻仅允许一个有效 `imWorkerPid`。
- 新 worker 启动成功后，只有 generation 与 session 当前 `spawnGeneration` 一致时才可注册为活跃 worker；否则立即终止为 stale worker。

初始化与生命周期约束：
- `initState='initialized'` 前禁止 `--resume`；首次 attach/IM 触发懒初始化（first-writer-wins）。
- `lifecycleStatus='archived'` 的 session 禁止进入任何运行态，仅允许查询与手动恢复/解档。

### 3.7 IPC 协议（Unix socket）

daemon 与 CLI/TUI 之间使用 **JSON Lines（每行一个 JSON）** 自定义协议。

请求：
```json
{"type":"request","requestId":"req-uuid","command":"create","args":{"name":"bug-fix","workdir":"/path"},"actor":{"source":"cli","userId":"local-user"}}
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
- `ACL_DENIED`
- `SESSION_BUSY`
- `INTERNAL_ERROR`

命令清单（IPC command）：
- `start`
- `stop`
- `status`
- `create`
- `list`
- `remove`
- `attach`
- `attach_exit`
- `takeover`
- `open_thread`
- `import`
- `acl_get`
- `acl_grant`
- `acl_revoke`
- `subscribe`（长连接，注册接收 server-push event；TUI 使用）

命令参数对齐（CLI ⇄ IPC，唯一真值表）：
- `mx-coder create <name> [--workdir] [--cli]` ⇄ `{command:"create", args:{name, workdir?, cli?}}`
- `mx-coder attach <name>` ⇄ `{command:"attach", args:{name}}`
- `mx-coder attach` 退出上报 ⇄ `{command:"attach_exit", args:{name, reason}}`
- `mx-coder takeover <name> [--mode hard|soft] [--grace-seconds 30]` ⇄ `{command:"takeover", args:{name, mode?, graceSeconds?}}`
- `mx-coder import <session-id> [--name] [--workdir] [--cli]` ⇄ `{command:"import", args:{sessionId, name?, workdir?, cli?}}`
- `mx-coder open <name>`（IM 快捷）⇄ `{command:"open_thread", args:{name}}`
- `mx-coder acl get <name>` ⇄ `{command:"acl_get", args:{name}}`
- `mx-coder acl grant <name> --user <id> --role <owner|operator|approver>` ⇄ `{command:"acl_grant", args:{name, userId, role}}`
- `mx-coder acl revoke <name> --user <id> --role <owner|operator|approver>` ⇄ `{command:"acl_revoke", args:{name, userId, role}}`

keepalive（长连接客户端，如 TUI）：

客户端：
```json
{"type":"ping","ts":1713000000000}
```

daemon：
```json
{"type":"pong","ts":1713000000001}
```

服务端主动推送（server push，daemon → 客户端）：

TUI 和处于 `attach_pending` 等待中的 CLI 保持长连接，daemon 在状态变更时主动推送 event：
```json
{"type":"event","event":"session_state_changed","data":{"name":"bug-fix","status":"idle","revision":5}}
{"type":"event","event":"attach_ready","data":{"name":"bug-fix"}}
```

事件列表：
- `session_state_changed`：任意 session 状态迁移后推送，携带 `name`、`status`、`revision`
- `attach_ready`：`attach_pending` 的 CLI 专用，`im_processing` 完成且 IM worker 已停止后推送，CLI 收到后继续执行 attach 流程

规则：
- 客户端每 15s 发送 `ping`
- daemon 超过 45s 未收到 `ping` 可主动关闭连接
- CLI 短连接命令可不发送心跳

ACL 执行闭环（强制）：
- 每个 request 必须携带 `actor`（来源与主体标识）。
- daemon 在命令执行前必须调用 `authorize(actor, action, session)`；鉴权失败返回 `ACL_DENIED`。
- `ACL_DENIED` 必须无副作用：不得入队、不得状态迁移、不得写入审批决策。

### 3.8 异常与恢复策略（Agent 运行时）

- `claude -p` 常驻 worker 崩溃：进入运行时恢复路径，表现为 `runtimeState=recovering`，执行退避重启（1s/3s/10s）；超过次数阈值进入 `error`
- 单条消息超时：当前消息标记 `failed`，worker 可被重置并重建；session 回到 `idle` 或 `runtimeState=recovering`，IM 回复“本条任务超时，请重试”（默认 `messageTimeoutSeconds=600`）
- API 限流（429）：遵循 CLI 原生重试/失败语义，daemon 不在 stdout 层做 429 文本解析与二次重试；若 worker 因 429 异常退出，按 `worker_crash` 路径处理
- 审批等待超时：`approval_pending` 最长等待 `permissionTimeoutSeconds`（默认 300 秒），超时后置 `expired` 并终止本轮工具调用；若该 worker 无法继续可靠恢复，则必须重建 worker
- daemon 重启恢复：
  - `pending approval` → `expired`（fail-closed）
  - `running message` → `confirm`（默认不自动重放）
  - `pending message` 默认 `replay`，但若消息含高风险工具审批上下文则降级为 `confirm`
  - `ready worker` 不做进程级恢复；daemon 重启后统一视为 `cold`，等待懒启动或 attach 后重新建立 worker
- 恢复幂等键：`dedupeKey=<plugin>:<threadId>:<messageId>`。同一 dedupeKey 在恢复期间不得重复执行工具调用。
- 恢复决策矩阵：
  - 低风险 + 无审批上下文 + 未完成执行：`replay`
  - 高风险或带审批上下文：`confirm`
  - 已明确拒绝或上下文失真不可恢复：`discard`
- `restoreAction='replay'` 时必须写入 `replayOf` 指针并审计。
- 对 AI agent 场景的要求：任何恢复动作都必须可审计（写入 correlationId、requestId、dedupeKey、恢复动作、操作者）

### 3.9 排队消息与接管策略

- `messageQueue` 是 session 级串行调度队列：负责去重、排队、恢复、重放与审批关联；**不是**“每条消息对应一个独立 Claude 进程”的生命周期容器
- 终端 `attached` 期间收到 IM 消息时，默认直接拒绝，不入队；若后续恢复“attach 期间允许排队”的策略，必须显式重新定义 takeover 与 attach 优先级，不能沿用旧语义
- 常驻 worker 存在时，队列按 FIFO 将消息逐条写入同一个 worker；前一条消息完成后，才允许发送下一条
- daemon 重启后：
  - `restoreAction='replay'`：自动重放（仅无审批依赖的低风险消息）
  - `restoreAction='confirm'`：向 IM 用户发确认卡片后再执行
  - `restoreAction='discard'`：明确丢弃并记录审计日志
- 接管策略：
  - 默认 `hard`：立即 SIGTERM（用于 agent 持续执行优先场景）
  - 可选 `soft`：先通知终端并给予 `graceSeconds`（默认 30s），超时后强制 SIGTERM

去重与重放约束：
- 入站消息命中相同 `dedupeKey` 时，不得重复入队与重复执行；应返回已存在处理结果或处理中状态引用。
- `confirm` 路径必须要求 approver/owner 显式确认后才允许再次执行。
- `discard` 必须保留可追溯审计记录，并回传 IM 明确提示已丢弃。

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

  // 幂等去重键：<plugin>:<threadId>:<messageId>
  dedupeKey: string;
}

interface ApprovalContext {
  sessionId: string;
  sessionName: string;
  messageId: string;
  correlationId: string;
  toolUseId: string;
  toolName: string;
  capability: 'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive';
  operatorId: string;
  requestId: string;
}

interface ApprovalRequest {
  requestId: string;
  sessionName: string;
  messageId: string;
  toolName: string;
  toolInputSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  capability: 'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive';
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

// IM 绑定：session 与某个 IM thread 的关联
interface IMBinding {
  plugin: string;       // IM plugin 名称（如 'mattermost'）
  threadId: string;     // IM thread/post ID
  channelId?: string;   // 所属 channel ID
  createdAt: string;    // ISO 8601
}

// 权限拦截配置（CLIPlugin.injectPermissionInterceptor 参数，挂在 CLI 插件配置下）
interface PermissionConfig {
  autoAllowCapabilities: Array<'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive'>;
  autoAskCapabilities:   Array<'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive'>;
  autoDenyCapabilities:  Array<'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive'>;
  autoDenyPatterns: string[];   // 兜底字符串匹配，格式 "ToolName:substring"
  timeoutSeconds: number;       // 审批等待超时（默认 300）
}
```

---

## 4. 插件系统

### 4.1 IM Plugin 接口

```typescript
interface IMPlugin {
  onMessage(handler: (msg: IncomingMessage) => void): void;
  sendMessage(target: MessageTarget, content: MessageContent): Promise<void>;
  createLiveMessage(target: MessageTarget, content: MessageContent): Promise<string>;
  updateMessage(messageId: string, content: MessageContent): Promise<void>;
  requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<void>;
  sendTyping?(target: MessageTarget): Promise<void>;
}
```

- `updateMessage` 用于流式增量更新，建议默认防抖窗口 500ms（插件可配置）
- `createLiveMessage` 返回 live messageId，后续 `updateMessage(messageId, ...)` 复用同一消息
- `sendTyping` 为可选能力：仅当插件原生支持 typing 且 session `runtimeState=running` 时，由 daemon/dispatcher 按节流策略调用

#### 4.1.1 StdioIMPlugin 设计与测试策略

定位：用于端到端测试与本地调试，不依赖真实 Mattermost/Slack。

协议约定（JSONL）：

- stdin 入站（IM -> daemon）
  - `{ "type": "message", "messageId": "...", "threadId": "...", "userId": "...", "text": "...", "dedupeKey": "..." }`
- stdout 出站（daemon -> IM）
  - `send`：普通消息
  - `live`：创建流式占位消息
  - `update`：更新同一条 live 消息
  - `approval`：审批请求

测试策略：
- 用 `Readable/Writable` mock stdin/stdout，不依赖终端真实 fd
- 覆盖单条消息链路：stdin → Dispatcher → mock claude → stdout
- 覆盖多消息串行处理：验证按 session 队列顺序输出多条 `live`
- 覆盖审批事件序列化：`requestApproval` 正确输出 `approval` JSON
- 覆盖容错：坏 JSON / 空行 / 未知 type 仅忽略，不崩溃


#### 4.1.2 Mattermost 长连接活性与 typing 约束

- Mattermost 插件必须区分三种状态：
  - **TCP 活着**：底层 socket 未断
  - **WS 已连接**：WebSocket open + 认证完成
  - **订阅逻辑活着**：在活性窗口内收到事件或 heartbeat ack
- 不得仅以 TCP/WS open 判断连接健康；若长期未收到业务事件，也必须通过应用层 heartbeat 验证逻辑存活
- 推荐字段：`lastWsOpenAt`、`lastWsMessageAt`、`lastHeartbeatSentAt`、`lastHeartbeatAckAt`
- 若超过活性窗口（例如 2~3 个 heartbeat 周期）未收到任何 WS 消息或 heartbeat ack，必须主动 close 当前 WS 并走重连流程
- REST 可用性与 WS 活性分开判断；`sendMessage()` 成功不代表 `onMessage()` 一定还能收到事件
- `sendTyping()` 只允许在以下条件同时满足时发送：
  - 插件原生支持 typing
  - 目标 session 当前 `runtimeState=running`
  - 距上次 typing 发送已超过节流窗口（建议 3~5 秒）
- Mattermost 的 REST typing 真值为 `POST /api/v4/users/{user_id}/typing`；`user_id` 使用 `connect()` 阶段解析出的 bot user id
- `waiting_approval`、`ready`、`cold`、`recovering`、`attached_terminal`、`takeover_pending` 均不发送 typing，避免误导用户认为 Claude 正在持续产出

Daemon 通过 `IMPlugin.sendMessage` / `updateMessage` 向用户推送需要交互的事件，回调由用户通过 `IncomingMessage` 入口触发。

```typescript
// Daemon → IM 的交互动作类型（由插件渲染为按钮/emoji/卡片）
type IMInteractionAction =
  | { action: 'approval_request';   requestId: string; toolName: string; riskLevel: string;   capability: string }
  | { action: 'confirm_replay';    dedupeKey: string;  messageId: string; toolName: string;  reason: string }
  | { action: 'takeover_request';  sessionId: string;  sessionName: string; softGraceSeconds?: number }
  | { action: 'queue_processing';  queueLength: number; currentMessage?: string }
  | { action: 'session_error';     sessionId: string;  error: string; recoverable: boolean }
  | { action: 'session_idle';      sessionId: string;  sessionName: string }
  | { action: 'worker_ready';       sessionId: string;  sessionName: string };

// IM → Daemon 的用户回调动作（IncomingMessage.text 解析后触发）
interface IMCallbackAction {
  action:
    | 'approve'          // 审批通过（携带 requestId/correlationId）
    | 'deny'             // 审批拒绝
    | 'cancel'           // 取消本轮审批/会话
    | 'takeover_hard'    // 强制接管（owner 专用）
    | 'takeover_soft'    // 软接管（先通知终端）
    | 'confirm_replay'   // 用户确认重放
    | 'discard';         // 用户确认丢弃
  requestId?: string;          // approval_request 对应
  correlationId?: string;      // 关联追踪
  sessionId?: string;          // takeover/replay/discard 需要
  operatorId?: string;         // 操作者（从 IncomingMessage.userId 填充）
  reason?: string;             // 可选说明
}
```

- 插件负责将 `IMInteractionAction` 渲染为 IM 可识别的交互元素（如 Mattermost button / emoji reaction）
- 插件将用户交互转换为 `IMCallbackAction`，通过 `onMessage` 回调传入 Daemon
- Daemon 在 `onMessage` 回调中对每条消息做 ACL 检查（见 §6）
- `approval_request` 回调中 `requestId` 必须与 pending 的 `ApprovalContext.requestId` 匹配；不匹配视为 stale 并审计丢弃
- `confirm_replay` 和 `discard` 回调必须携带原始 `dedupeKey`，确保幂等

### 4.2 CLI Plugin 接口

```typescript
// 已知事件强类型（parseStream 必须严格校验）
interface CLISystemEvent     { type: 'system';          sessionId: string; messageId: string; payload: { session_id: string; tools: unknown[]; [key: string]: unknown }; }
interface CLIAssistantEvent { type: 'assistant';        sessionId: string; messageId: string; payload: { content: CLIBlock[]; [key: string]: unknown }; }
interface CLIUserEvent      { type: 'user';             sessionId: string; messageId: string; payload: { content: CLIBlock[]; [key: string]: unknown }; }
interface CLIResultEvent    { type: 'result';           sessionId: string; messageId: string; subtype: 'success'|'error'; is_error: boolean; result: string; }
interface CLIAttachmentEvent    { type: 'attachment';    sessionId: string; messageId: string; payload: Record<string, unknown>; }
interface CLILastPromptEvent     { type: 'last-prompt';   sessionId: string; messageId: string; payload: Record<string, unknown>; }
interface CLIQueueOpEvent       { type: 'queue-operation'; sessionId: string; messageId: string; payload: Record<string, unknown>; }

// 未知类型兼容事件（保留 rawType，不丢弃）
interface CLIUnknownEvent    { type: 'unknown';          sessionId: string; messageId: string; rawType: string; payload: Record<string, unknown>; }

type CLIEvent =
  | CLISystemEvent | CLIAssistantEvent | CLIUserEvent | CLIResultEvent
  | CLIAttachmentEvent | CLILastPromptEvent | CLIQueueOpEvent
  | CLIUnknownEvent;

interface CLIBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  // tool_use: { type:'tool_use'; id: string; name: string; input: Record<string, unknown> }
  // tool_result: { type:'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  [key: string]: unknown;
}

interface CLIPlugin {
  name: string;

  // 终端模式：构建交互式启动命令
  buildAttachCommand(session: Session): { command: string; args: string[] };

  // IM 模式：构建长驻 IM worker 启动命令
  // bridgeScriptPath 由 daemon 在 spawn 前生成（generateBridgeScript），注入 --permission-prompt-tool
  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): { command: string; args: string[] };

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
  // bridgeScriptPath 由 daemon 在 spawn 前通过 generateBridgeScript() 生成
  buildIMWorkerCommand(session: Session, bridgeScriptPath: string) {
    return {
      command: 'claude',
      args: ['-p', '--resume', session.sessionId,
             '--input-format', 'stream-json',
             '--output-format', 'stream-json', '--verbose',
             '--permission-prompt-tool', `node ${bridgeScriptPath}`],
    };
  }
}
```

补充约束：
- 常驻 worker 模式下，插件必须保证“同一 worker 可连续接收多条 stdin JSONL 消息”，且 stdout 事件流可被持续解析。
- 消息边界不能再依赖“子进程退出”判定，必须以 Claude 输出流中的 `result` 事件作为一条消息完成的提交边界。
- attach 与 IM 复用同一 `sessionId`，但不能复用同一进程；控制权切换时必须先停止当前控制端对应的 Claude 进程。

### 4.3 插件加载与扩展指南

插件以 npm 包或本地目录形式存在，配置文件声明，动态 import 加载：

```yaml
plugins:
  im:
    - name: mattermost
      package: "@mx-coder/plugin-mattermost"
  cli:
    - name: claude-code
      package: "@mx-coder/plugin-claude-code"
```

新增 IM 插件（示例：Discord）：
1. 新建 `src/plugins/im/discord.ts`，实现 `IMPlugin` 五个核心方法。
2. 在 `onMessage` 中把 Discord 入站消息映射为统一 `IncomingMessage`。
3. 在 `sendMessage/createLiveMessage/updateMessage/requestApproval` 中实现 Discord API 调用。
4. 按 thread/channel 语义实现 `threadId` 映射，保证 `SessionRegistry.getByIMThread()` 可路由。
5. 补齐单测（协议映射）+ 集成测试（消息链路、审批、错误重试）。

新增 CLI 插件（示例：Gemini CLI）：
1. 新建 `src/plugins/cli/gemini.ts`，实现 `CLIPlugin`：
   - `buildAttachCommand`
   - `buildIMWorkerCommand`
   - `generateSessionId`
2. 输出流必须兼容 `parseStream` 产出的统一 `CLIEvent`，至少覆盖 `assistant/result/system`。
3. 权限拦截优先复用 Gemini 原生 Policy Engine，而不是绕过到外层字符串匹配。
4. 保证 `--resume <sessionId>` 语义稳定，sessionId 由插件生成并持久化。
5. 补齐插件单测（命令构建、流解析）与跨插件回归（attach/IM/approval）。

---

## 5. 权限审批

### MCP Bridge 通信拓扑（Claude Code 场景）

Daemon 是常驻进程，Claude Code 的 `--permission-prompt-tool` 要求一个**以 stdio 通信的 MCP server**（子进程方式）。为避免额外进程，采用 **Stdio↔Socket Bridge** 方案：

```text
Daemon 启动时：
  → 在 Unix socket（~/.config/mx-coder/mcp-bridge.sock）上监听 MCP 协议

spawn IM worker 时：
  → 动态生成临时 bridge 脚本（mcp-bridge-<sessionId>.js）：
      连接 mcp-bridge.sock，双向转发 stdin↔socket
  → 以 stdio 子进程方式传给 claude：
      --permission-prompt-tool "node /tmp/mx-coder-mcp-bridge-<sessionId>.js"

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
- mx-coder 上层维护统一的审批状态机（`pending / approved / denied / expired / cancelled`），底层由各 CLI plugin 接入自己的原生机制
- MCP 在 Claude Code 场景下同时承担 permission prompt 和未来扩展模型工具能力的职责

### 终端模式

直接使用 AI CLI 原生审批（Claude Code 自带的终端权限确认），无需干预。

### IM 模式（以 Claude Code 为例）

Claude Code IM 审批已选定方案（Spike 定版）：

#### 选定方案：`--permission-prompt-tool` + daemon MCP server

```text
claude -p 执行中，要调用 Write 工具
  → Claude Code 调用 permission prompt tool (mx-coder-permission)
  → mx-coder daemon 的 MCP server 收到 can_use_tool 请求
  → daemon 在 IM thread 中发审批消息
  → 用户批准或拒绝
  → MCP server 返回 allow/deny 给 Claude Code
  → Claude Code 执行或拒绝工具
```

daemon MCP server 通过 Unix socket 与 IM worker 通信，实现本地审批路由，无需单独进程。

**结论（Spike 定版）：**
- Claude Code IM 审批：**仅采用 PermissionRequest（MCP）机制**
  - daemon 充当 MCP server，实现 `can_use_tool` tool
  - IM worker 通过 `--permission-prompt-tool "node /tmp/mx-coder-mcp-bridge-<sessionId>.js"` 连接 daemon MCP server
  - `sendRequest` 返回 Promise，天然支持 IM 用户异步审批
  - autoAllow/autoDeny 在 daemon MCP server 层做规则匹配，命中则同步返回，无需打扰用户
- Claude Code 终端模式：直接使用 Claude Code 原生权限确认，无需干预
- Codex / Gemini：各自复用原生机制（Approval Mode / Policy Engine），不在 mx-coder 范围内统一抽象
- **PreToolUse Hook 不引入**：它无法等待 IM 异步响应，且与 PermissionRequest 存在职责重叠，引入会增加状态机复杂度；如需在终端模式本地过滤危险命令，可在全局 Claude Code settings 中单独配置，不在 mx-coder 项目范围内

**配置（挂在 CLI 插件下，非全局）：**

```yaml
plugins:
  cli:
    - name: claude-code
      package: "@mx-coder/plugin-claude-code"
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

### 6.1 三入口强制鉴权矩阵

每个入口在入口处必须完成 ACL 检查，检查失败返回 `ACL_DENIED`，**不得产生副作用**（不入队、不迁移状态、不更新审批、不写入队列）。

#### 入口一：CLI 命令入口

CLI 命令经 IPC socket 发送至 daemon，socket server 在派发命令前完成 actor 鉴权。

| 命令 | 所需角色 | ACL_DENIED 行为 |
|---|---|---|
| `attach` / `attach_exit` | owner | 拒绝 attach，返回错误 |
| `create` | — | 任何人可创建（创建者为 owner） |
| `list` / `status` | — | 任何人可读（隐藏敏感 metadata） |
| `message` | operator | 拒绝入队 |
| `takeover` | owner | 拒绝，IM 通知无权限 |
| `remove` / `archive` | owner | 拒绝删除/归档 |
| `acl_grant` / `acl_revoke` | owner | 拒绝修改 |
| `reset` | owner | 拒绝重置 |

#### 入口二：IM 消息入口（IncomingMessage）

每条 `IncomingMessage` 进入 daemon 时，先解析为 `IMCallbackAction`，再鉴权。

| action | 所需角色 | ACL_DENIED 行为 |
|---|---|---|
| `approve` | approver | 视为 deny，写审计日志 |
| `deny` | approver | 视为 cancel，写审计日志 |
| `cancel` | approver | 正常 cancel（幂等） |
| `takeover_hard` | owner | 拒绝，IM 通知无权限 |
| `takeover_soft` | owner | 拒绝，IM 通知无权限 |
| `confirm_replay` | approver+ | 拒绝，IM 提示无权限 |
| `discard` | approver+ | 拒绝，IM 提示无权限 |
| 纯文本消息（对话） | operator | 拒绝入队，返回"无权限" |

> "approver+" 表示：若 session 开启了 `scope=session` 缓存，该操作还要求操作者在该 capability 维度上持有 approver 角色。

#### 入口三：审批动作入口（MCP `can_use_tool` 回调）

`can_use_tool` 由 daemon MCP server 内部调用，source 固定为 `daemon`，不受 IM/CLI ACL 约束，但受以下限制：

- `autoAllow`：仅限 `capability=read_only` 且 `riskLevel=low`
- `autoDeny`：仅限 `capability in [shell_dangerous, network_destructive]`
- 其余均必须通过 `requestApproval` 等待 IM 审批

### 6.2 SESSION_BUSY 与 ACL_DENIED 语义

- **`ACL_DENIED`**：无副作用。审计日志记录 `actor`（userId/plugin/operatorId），返回结构化错误码。
- **`SESSION_BUSY`**：表示 session 锁被其他操作持有。CLI 命令层返回 "session busy" 并提示稍后重试；IM 层不入队，等待下一次 poll/事件触发。
- 两者不可混用：`ACL_DENIED` 是权限问题，`SESSION_BUSY` 是并发问题。

### 6.3 scope=session 粒度说明

缓存键：`sessionId + operatorId + capability`
- 生命周期：session 结束、接管（hard takeover）、或 session reset 时失效
- `capability` 维度：`read_only | file_write | shell_dangerous | network_destructive`
- `autoAllow` 写穿缓存：`operatorId + capability` 首次审批通过后，同一 session 内同 capability 后续直接放行

### 6.4 审批交互协议

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
  - 运行日志：`~/.config/mx-coder/logs/daemon.log`
  - 审计日志：`~/.config/mx-coder/logs/audit.log`
- 关键审计事件：审批动作、接管动作、session 删除/归档、危险工具调用、恢复动作
- 每条审计日志必须包含：`timestamp`、`sessionId`、`correlationId`、`requestId`（如有）、`operatorId`（如有）、`action`、`result`

本地 IPC（Unix socket）安全：
- socket 文件权限固定为 `0600`，目录为 `0700`
- 仅允许同 UID 进程连接；若检测到 UID 不一致，立即拒绝并审计

---

## 7. IM 交互

### 路由模型

- **Channel 主消息流**：信息命令（/help, /list, /status）、导航命令（/open）以及顶层普通文本
- **Thread（一对一）**：每个命名 session 最多绑定一个独立 thread；消息自动路由，无需切换命令
- **并行交互**：不同 thread 可同时与各自 session 交互，互不干扰
- **重新打开 Thread**：`/list` 列出所有 session 及其当前绑定 thread（当前实现展示 `threadId`）；`/open <name>` 在任意位置都可执行：若 session 未绑定 thread，则创建新的独立 thread 并绑定；若已绑定，则向目标 thread 发送定位消息。若后续发现已绑定 thread 不可用，应创建新 thread 并重新绑定

### IM 命令分类与回复目标

所有 IM 命令通过 `msg.isTopLevel`（是否为 channel 根帖）选择**回复位置**，但不再决定 `/open` 的可用性。回复目标规则：
- `isTopLevel=true`（channel 根帖）：回复到 channel（`threadId=''`）
- `isTopLevel=false`（thread 内）：回复到当前 thread（`threadId=msg.threadId`）

#### A. 信息命令（isTopLevel 或 thread / session channel 均可）

| 命令 | 行为 | 回复目标 |
|------|------|---------|
| `/help` | 显示帮助文本 | `isTopLevel ? '' : 当前会话空间` |
| `/list` | 列出所有 session 及绑定位置与空间策略 | `isTopLevel ? '' : 当前会话空间` |
| `/status` | 显示全局或当前 session 状态；包含当前 Mattermost 默认 `spaceStrategy`、当前 session 实际绑定空间类型与当前 `streamVisibility` | `isTopLevel ? '' : 当前会话空间` |
| `/stream` | 显示当前 session 的输出模式；`/stream normal|thinking|verbose` 可在当前 thread / session channel 内切换 IM 输出可见性 | 当前会话空间 |

#### B. 导航命令（isTopLevel 或 thread / session channel 均可）

| 命令 | 行为 | 回复目标 |
|------|------|---------|
| `/open <name>` | 根据当前 `spaceStrategy`：thread 模式则创建/定位 thread；channel 模式则通过主 channel 索引入口创建/定位独立 private channel。已有绑定则跳转到对应会话空间 | 当前上下文 ack + 目标会话空间 |

#### C. 不支持的命令（仅会话空间中返回错误，不落入 CLI）

| 命令 | 行为 | 回复目标 |
|------|------|---------|
| `/remove`、`/attach`、`/create` 及任何其他 `/xxx` | 返回"该命令不支持在 IM 中使用，请使用 mx-coder CLI" | 当前会话空间 |

#### D. 未知顶级命令（仅 isTopLevel）

| 命令 | 行为 | 回复目标 |
|------|------|---------|
| 其他 `/xxx`（非 A/B 类） | 回复"未知命令"错误，不创建命名 session | `''`（channel） |

#### E. 普通文本消息（顶层或会话空间内）

| 内容 | 行为 |
|------|------|
| 普通文本消息（非 `/` 开头） | 进入 Claude 处理流程，消息入队由 `IMMessageDispatcher` 串行处理；若当前上下文尚未绑定任何 session，则自动创建一个 IM 会话（`im-*`），其会话空间由当前 `spaceStrategy` 决定 |

| 审批交互 | 行为 |
|------|------|
| 主路径 | 在会话 thread / session channel 中发送一条审批卡片，由用户直接用 reaction 决策 |
| 👍 | `Yes, once`：仅放行本次 tool call |
| ✅ | `Yes, for this session`：按 `sessionId + operatorId + capability` 写入 session scope cache |
| 👎 | `No`：拒绝本次 tool call |
| ⏹️ | `Cancel`：取消当前审批等待，不等同 deny |
| 文本 fallback | 主语法支持最近一个 pending approval：`/approve once`、`/approve session`、`/deny`、`/cancel`；兼容旧写法 `/approve last once`、`/approve last session`、`/deny last`、`/cancel last` |
| 禁止项 | 不要求用户手输完整 `requestId`；完整 requestId 仅用于内部关联与审计 |
| permission prompt tool 协议 | MCP tool 返回必须是单个 text block，`text` 内容为 JSON 字符串：allow 时 `{"behavior":"allow","updatedInput":<input>}`，deny 时 `{"behavior":"deny","message":"..."}`；输入字段优先使用 `input`，兼容 `tool_input` |
| session 级授权真值 | `for session` 仍按 `sessionId + operatorId + capability` 粒度缓存；其中 `operatorId` 应以 daemon 记录的当前活动消息发起者为真值来源，`capability` 优先使用 MCP 透传值，缺失时由 daemon 依据 `toolName + input` 做保守推导兜底 |
| reaction 事件源 | WS 优先；若审批 post 的 reaction 已落库但未收到 WS 事件，则对待决审批 post 轮询 `/posts/{id}/reactions` 作为 REST fallback；必须过滤 bot 自己预置的 reaction，只接受非 bot 用户的审批 |
| 审批消息体验 | 审批消息发出后应由 bot 自动预置 👍 / ✅ / 👎 / ⏹️ 四个 reaction，避免用户手动从 emoji 面板搜索 |
| stop/restart 可观测性 | CLI 在 stop/restart 的长路径中应输出阶段进度（stopping / waiting graceful shutdown / waiting socket release / starting），避免用户误判为卡死 |

### Mattermost 示例

```
# ===== Channel 主消息流（信息命令 / 导航命令）=====

用户: /list
Bot:  ● bug-fix    (idle)      ~/myapp    → [space=thread:abc123]
      ● review-pr  (attached)  ~/other    → [space=thread:def456]  ← 终端使用中
      当前 Mattermost 默认新建模式：thread

用户: /open bug-fix
Bot:  已在会话 bug-fix 的 thread 中发送定位消息。

用户: /open demo   # demo 尚未绑定任何会话空间
Bot:  已按当前模式为会话 demo 创建独立会话空间，并发送定位消息，可直接开始对话。

用户: 这个 root post 直接跟进一下
Bot:  [自动创建/命中当前上下文对应的 IM 会话，并进入 Claude 处理流程；空间类型由当前配置决定]


# ===== Thread / Session Space 内会话（直接对话，无需前缀） =====

用户: /help
Bot:  [帮助文本]

用户: /status
Bot:  [当前 session 状态 + runtimeState + 当前 Mattermost 默认新建模式 + 当前 session 实际绑定空间类型]

用户: /open bug-fix
Bot:  [在当前上下文发确认，目标会话空间发定位消息]


# ===== Session A: bug-fix（直接对话，无需前缀） =====

用户: auth 模块的实现逻辑是什么？
Bot:  [Claude Code 回复，Markdown 格式化]

用户: 把 JWT 改成 session-based
Bot:  ⚠️ 权限请求: Write → src/auth.ts
      👍 允许  👎 拒绝
用户: 👍
Bot:  ✅ 已允许
Bot:  [Claude Code 完成修改的回复]


# ===== Session B: review-pr（同时进行） =====

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
# ~/.config/mx-coder/config.yaml

plugins:
  im:
    - name: mattermost
      package: "@mx-coder/plugin-mattermost"
      config:
        url: https://mattermost.example.com
        token: bot-token
        channelId: default-channel
        spaceStrategy: thread   # thread | channel，默认 thread，仅影响未来新建 session
        # teamId: team-id       # 当 spaceStrategy=channel 时必填
  cli:
    - name: claude-code
      package: "@mx-coder/plugin-claude-code"
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
  path: ~/.config/mx-coder/sessions.json

ipc:
  socketPath: ~/.config/mx-coder/daemon.sock

ui:
  defaultMode: headless  # headless | tui
```

---

## 9. 运行模式

### Headless 模式（默认）

`mx-coder start` 启动 daemon 后在后台运行，通过普通 CLI 命令和 IM 完成交互。

**适用场景：**
- 日常使用
- 服务器 / 远程开发机
- 主要依赖 IM 远程推进任务
- 脚本化或开机自启

### TUI 模式

`mx-coder tui` 连接 daemon 的 IPC（Unix socket），通过 `subscribe` 长连接接收 server-push event，持续运行并实时重绘状态面板。支持 SIGINT/SIGTERM 优雅退出。

#### 当前已落地能力（monitor baseline）

- 查看所有 session 的状态（cold / ready / running / waiting_approval / attached_terminal / queue length / 最近活动时间）
- 查看哪些 session 正在等待权限审批
- 实时监控多会话运行情况（基于 daemon 推送的 `session_state_changed` 事件自动刷新）

#### 产品定位（后续演进真值）

TUI 的目标定位不是“只读状态看板”，而是 **session workbench（会话工作台）**：

- 以 **session** 为一级对象，而不是以 daemon 指标为中心
- 在单个全屏界面内完成 **选中 session → 查看输出流 → 发送消息 / 命令 → 处理审批 / 控制权切换** 的主路径
- 保留当前 monitor 能力，但降级为 workbench 中的一个视图，而不是 TUI 的最终形态

#### TUI 必须承载的能力边界

后续版本中的 TUI 至少应覆盖以下工作台能力：

1. **Session 列表与焦点切换**
   - 展示多 session 总览
   - 支持快速切换当前焦点 session
   - 清晰标识 busy / idle、runtimeState、queue length、binding kind、error / approval / attached 等关键信号
2. **当前 session 的消息流视图**
   - 展示用户输入、Claude/底层 coder 输出、系统事件、审批事件与恢复事件
   - 支持流式增量刷新、滚动查看与 turn 边界区分
3. **底部输入框**
   - 支持直接向当前 session 发送普通消息
   - 支持 `//<cmd>` 原生命令透传
   - 支持 `/...` 形式的 TUI 内部控制命令
4. **审批工作流**
   - 在 `waiting_approval` 时显著展示待审批请求
   - 支持在 TUI 内直接 approve / deny，并能查看请求摘要与风险语义
5. **控制面快捷操作**
   - 至少支持 attach、open、takeover status、takeover cancel、diagnose 等会话级动作
6. **实时状态订阅**
   - 继续以 daemon subscribe 推送为单一真值来源，驱动列表、消息流、审批态与控制态刷新

#### 非目标与硬边界

TUI 即使演进为 workbench，也不承担以下职责：

- **不内嵌原生 attach 交互会话**：真正进入 Claude Code 工作时，仍执行 `mx-coder attach <name>`，保持终端原生体验
- **不把自己做成编辑器 / IDE**：首期不引入文件树、代码编辑器、伪终端代理等与会话编排无关的重量功能
- **不替代 daemon/CLI 插件职责**：TUI 是控制与观察界面，不拥有独立的会话真值或额外状态机

#### 推荐布局约束

默认布局应优先采用“**session 列表 + 当前会话主视图 + 底部输入栏**”的工作台结构，而不是继续扩展单页表格式看板。原因是：

- 左侧负责上下文切换
- 右侧负责会话工作过程
- 底部负责动作输入

这比继续堆叠状态字段更符合多 session agent 工作流。

#### 分期规划（产品视角）

- **TUI-M1：Monitor 基线（已完成）**
  - subscribe 长连接
  - session 总览
  - approval / attached / recovering 等标识
- **TUI-M2：Workbench MVP**
  - session 列表
  - active session 流式消息区
  - prompt 输入框
  - 审批卡片与 approve / deny
  - attach / open / takeover 等快捷控制动作
- **TUI-M3：可用性增强**
  - 搜索 / 过滤
  - 快捷键帮助面板
  - unread / error / busy 标记
  - status line
  - stream visibility 切换
- **TUI-M4：高级体验**
  - peek / preview
  - pinned sessions
  - command palette
  - env/detail panel 等辅助视图

#### 适用场景

- 在电脑前同时推进多个 session，需要总览 + 焦点工作台
- 希望在单独终端 tab 中持续观察 daemon 与 session 状态
- 需要在同一界面内快速完成监控、审批和控制权切换

### Session 生命周期与清理

> `runtimeState`（cold/ready/running/waiting_approval 等）与 `lifecycleStatus`（active/stale/archived）**独立演进**，互不阻塞。

**runtimeState**（见 §3.6 状态机）：描述会话当前运行语义。它不等同于控制面 `status`，而是额外表达该 session 的 IM worker 是否尚未建立（cold）、已建立待命（ready）、正在执行（running）、等待审批（waiting_approval）等。  
**lifecycleStatus**（见 §3.2）：描述会话整体健康阶段，迁移相对缓慢：

- `active` → `stale`：`runtimeState` 长期停留在 `cold` 或 `ready` 且持续超过 `sessionTimeoutMinutes`
- `stale` → `archived`：持续超过 `retention.sessionArchiveDays`（无论 `status` 如何）
- `archived` 后的 session **禁止进入任何运行态**（attach/IM message 入队均拒绝），仅允许 owner 执行 remove/list

**initState**（见 §3.2）：描述首次初始化进度（uninitialized/initializing/initialized/init_failed），与上述两者独立。`initState=initialized` 前：
- 禁止 `--resume`（必须从零创建）
- 首次 attach 或首次 IM 消息触发懒初始化（first-writer-wins）

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

## 11. 第二阶段实现顺序

```text
Phase A: 设计收口（当前阶段）
  - 明确常驻 IM worker 架构
  - 重定义 runtimeState 与控制面 status 的边界
  - 明确 attach/takeover/approval/recovery 语义
  - 同步 README/SPEC

Phase B: 常驻 worker 基线（TDD）
  - 先补 IMWorkerManager / CLIPlugin / parseStream 的单测
  - 改为单 session 单常驻 worker，消息通过 stdin.write(JSONL)
  - 以 `result` 事件而非进程退出作为消息完成边界

Phase C: 状态机与控制权切换（TDD）
  - 重定义 runtimeState 映射
  - 实现 attach 前停 worker、attach_pending、takeover 与恢复逻辑
  - 修正 messageQueue 在常驻 worker 模式下的职责

Phase D: 审批与恢复（TDD）
  - 让 approval_pending 绑定到常驻 worker 当前执行上下文
  - 处理审批超时、takeover 取消审批、worker 崩溃后的恢复决策
  - 明确 daemon 重启后 ready worker 不做进程级恢复

Phase E: 闭环验证
  - unit / integration / e2e 全量补齐
  - build / test 收口
  - README / SPEC 与实现对齐复核
```

---

## 待定

详见 `docs/TODO.md`（单一待办来源，避免与 SPEC 重复维护）。
