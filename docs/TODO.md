# TODO

Review 产出的待解决问题，按优先级排列。

---

## P0: 技术假设验证（Spike）

在写代码前必须验证，任何一个不成立都需要调整方案。

- [ ] **`-p` 模式与交互模式 session 兼容性** — 验证 `claude -p --session-id X --resume` 和 `claude --session-id X --resume` 交替使用是否共享同一会话上下文、状态是否一致
- [ ] **PreToolUse Hook 超时行为** — 验证 Claude Code 对 PreToolUse hook 脚本的执行是否有超时限制，能否支持长时间阻塞等待（≥300s）
- [ ] **长 session 的 context window 行为** — 验证 `-p --resume` 加载长历史 session 时，Claude Code 如何处理 context window 溢出（截断？摘要？报错？）

## P1: 架构缺陷

### Session 状态模型

- [ ] 扩展为三态：`attached | im_processing | idle`，增加 `imProcessingPid` 字段
- [ ] 终端 attach 时如果 IM 正在处理（`im_processing`），定义行为：等待完成 / 强制终止
- [ ] 增加 PID 存活检测，防止 attach 流程崩溃导致 session 永远卡在 attached 状态
- [ ] 定义 SIGTERM 接管前的 session 状态完整性保证（需结合 spike 验证结果）
- [ ] 确保 `attachedPid` 是 spawn 的直接子进程 PID，避免进程树多层导致 kill 错误进程

### 接管机制

- [ ] 定义被接管退出 vs 正常退出的区分方式（daemon 预标记退出原因，attach 退出后查询）
- [ ] 考虑 SIGTERM 前先发"软通知"让终端用户主动退出的选项

### 安全模型

- [ ] IM 端用户鉴权：定义谁能发命令、谁能审批权限请求（配置授权用户列表）
- [ ] `autoDeny` 字符串匹配易绕过（`rm -rf` vs `rm -r -f` vs 变量拼接），改为 Bash 白名单模式或声明为 best-effort

## P2: 接口补全

### CLIPlugin

- [ ] 增加 `parseStream(stream: ReadableStream): AsyncIterable<ParsedChunk>` 流式输出解析
- [ ] 增加 `generateSessionId(): string` — 不同 CLI 的 session ID 格式可能不同
- [ ] 增加 `validateSession(sessionId: string): Promise<boolean>` — attach/消息前验证 session 有效性

### IMPlugin

- [ ] `sendMessage` content 改为结构化类型，支持 text/markdown/file
- [ ] 增加 `updateMessage(target, messageId, content)` — 流式输出场景下更新同一条消息
- [ ] `requestApproval` 返回类型扩展为 `ApprovalResult`，支持 scope（本次/永久/session 内）

### 类型定义

- [ ] 定义 `IncomingMessage`、`MessageTarget`、`ApprovalRequest`、`ParsedOutput` 等核心类型

## P3: 设计补充

### 异常处理

- [ ] `claude -p` 进程崩溃/超时的处理策略
- [ ] API 限流错误的处理策略
- [ ] daemon 崩溃后的恢复机制（session 持久化 + 自动重建状态）

### 运行模式

- [ ] 补充 `mm-coder tui`：通过 IPC 连接 daemon，提供多 session 总览和审批状态监控
- [ ] 明确 TUI 与 attach 的边界：TUI 仅做控制台，不承载 AI CLI 交互

### IPC

- [ ] 明确 IPC 方案：统一 Unix domain socket，定义 socket 文件路径（如 `~/.config/mm-coder/daemon.sock`）

### Hook 注入

- [ ] 明确 IM 模式下 PreToolUse hook 的注入方式，确保不影响终端模式（通过环境变量或临时配置目录隔离）

### 排队消息

- [ ] 定义终端 detach 后排队消息的自动处理行为

### 权限配置归属

- [x] permissions 配置改为挂在 CLI 插件下（不同 CLI 的工具名不同）

### 命令一致性

- [ ] 对齐 IM 命令和 CLI 命令的参数格式

### 可观测性

- [ ] 定义日志策略：级别、输出位置、关键操作审计日志

### Session 生命周期

- [ ] 定义 session 清理策略：TTL / 手动归档 / 最大数量限制
