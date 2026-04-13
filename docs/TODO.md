# TODO

Review 产出的待解决问题，按优先级排列。

---

## P0: 技术假设验证（Spike）

在写代码前必须验证，任何一个不成立都需要调整方案。

- [x] **`-p` 模式与交互模式 session 兼容性** — 已验证：`claude --resume <id>` 和 `claude -p --resume <id> --input-format stream-json --output-format stream-json --verbose` 交替使用共享同一会话上下文；`--input-format stream-json` 使进程长驻接受多条消息；审批通过 `sendToolResult` 直接写回 stdin，无需 MCP server 中转；`--permission-prompt-tool` 隐藏参数在 v2.1.100 中存在可用
- [ ] **Claude Code 双审批方案对比** — 对比 `--permission-prompt-tool + MCP server` 与 `PreToolUse Hook`，验证二者在 `-p --resume` 场景下的稳定性、超时行为、实现复杂度和恢复语义
- [ ] **长 session 的 context window 行为** — 验证 `-p --resume` 加载长历史 session 时，Claude Code 如何处理 context window 溢出（截断？摘要？报错？）
- [ ] **SIGTERM 接管后的恢复性** — 验证 Claude Code 被终止时 session 是否可恢复，以及工具执行中断是否会导致不一致
- [ ] **stream-json 事件结构稳定性** — 采集和验证增量输出、工具调用、错误、结束事件的结构与版本稳定性

## P1: 架构缺陷

### Session 状态模型

- [ ] 扩展为显式状态机：`idle | attached | im_processing | approval_pending | takeover_pending | recovering | error`
- [ ] 定义合法状态迁移与非法迁移处理规则
- [ ] 增加 PID 存活检测，防止 attach / IM 流程崩溃导致 session 卡死（`attachedPid` 和 `imWorkerPid` 双轨检测）
- [ ] 定义退出原因模型：`normal | taken_over | cli_crash | recovered`
- [ ] 明确 attach 时若 IM 正在执行，终端侧的行为：等待 im_processing 完成后再 attach，界面显示等待提示

### IM Worker 生命周期

- [ ] 懒启动策略：daemon 重启后不主动重建 IM worker，首条 IM 消息到来时 spawn，同时向 IM 发送"正在启动 Claude Code，请稍候..."
- [ ] Pre-warm 策略：`mm-coder attach` 退出后（session 仍在工作语义中），立即 spawn 新的 IM worker（`claude -p --resume <id> --input-format stream-json --output-format stream-json --verbose`）
- [ ] 崩溃重启策略：非正常退出（exit code ≠ 0）才重启；最大重试次数可配置（默认 3 次）；超出后 session → `error` 并通知 IM 用户
- [ ] `imWorkerCrashCount` 连续崩溃计数重置规则：成功处理一条消息后清零

### 接管机制

- [ ] 定义被接管退出 vs 正常退出的区分方式（daemon 预标记退出原因，attach 退出后查询）
- [ ] 评估“软通知 + 宽限期 + 强制终止”的接管流程是否值得引入
- [ ] 确保 `attachedPid` 是 spawn 的直接子进程 PID，避免进程树多层导致 kill 错误进程

### 安全模型

- [ ] IM 端用户鉴权：定义谁能发命令、谁能审批权限请求、谁能接管 session
- [ ] 审批状态机：`pending / approved / denied / expired / cancelled`
- [ ] 定义 fail-closed 策略：IM 不可达、daemon 崩溃、审批超时默认拒绝
- [ ] 定义审批交互协议：`requestId` 生成、动作模型、旧审批失效规则
- [ ] `autoDeny` 字符串匹配仅视为 best-effort，设计能力分类 + 风险等级策略

## P2: 接口补全

### CLIPlugin

- [x] 增加 `generateSessionId(): string` — 不同 CLI 的 session ID 格式可能不同
- [x] 增加 `validateSession(sessionId: string): Promise<boolean>` — attach/消息前验证 session 有效性
- [x] 将 `buildMessageCommand` 改为 `buildIMWorkerCommand`：长驻进程启动命令，不再以 per-message 方式启动进程
- [ ] 定义 mm-coder 内部统一事件模型（如 `assistant_delta / assistant_final / tool_call / approval_request / status / error`）
- [ ] 增加 `parseStream(stream: ReadableStream): AsyncIterable<ParsedChunk>` 流式输出解析

### IMPlugin

- [ ] `sendMessage` content 改为结构化类型，支持 text/markdown/file
- [ ] 增加 `updateMessage(target, messageId, content)` — 流式输出场景下更新同一条消息
- [ ] `requestApproval` 返回类型扩展为 `ApprovalResult`
- [ ] 评估审批 scope 是否支持“本次 / 本 session”

### 类型定义

- [ ] 定义 `IncomingMessage`、`MessageTarget`、`ApprovalRequest`、`ApprovalResult`、`CLIEvent` 等核心类型

## P3: 设计补充

### 异常处理

- [ ] `claude -p` 进程崩溃/超时的处理策略
- [ ] API 限流错误的处理策略
- [ ] daemon 崩溃后的恢复算法：session、pending message、pending approval 的保守重建

### 运行模式

- [ ] 补充 `mm-coder tui`：通过 IPC 连接 daemon，提供多 session 总览和审批状态监控
- [ ] 明确 TUI 与 attach 的边界：TUI 仅做控制台，不承载 AI CLI 交互

### IPC

- [ ] 明确 IPC 方案：统一 Unix domain socket，定义 socket 文件路径（如 `~/.config/mm-coder/daemon.sock`）
- [ ] 为 Unix socket 增加最小权限与对端身份校验

### Hook / Prompt Tool 注入

- [ ] 明确 Claude Code 审批策略选定后的注入方式与隔离方案（`permission-prompt-tool + MCP server` / `PreToolUse Hook`）

### 排队消息

- [ ] 定义终端 detach 后排队消息的自动处理行为
- [ ] 定义 pending message 的恢复语义：daemon 重启后是重放、丢弃还是标记待确认

### 权限配置归属

- [x] permissions 配置改为挂在 CLI 插件下（不同 CLI 的工具名不同）

### 命令一致性

- [ ] 对齐 IM 命令和 CLI 命令的参数格式
- [ ] 增加 `mm-coder import <session-id> [--name] [--workdir]` 命令，支持导入外部启动的 Claude Code session

### 可观测性

- [ ] 定义日志策略：级别、输出位置、关键操作审计日志
- [ ] 增加高风险操作审计日志：审批、接管、删除 session、危险工具调用

### Session 生命周期

- [ ] 定义 session 清理策略：TTL / 手动归档 / 最大数量限制
