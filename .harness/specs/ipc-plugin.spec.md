---
# HARNESS METADATA
# type: specification
# part-of: harness-architecture
# scope: ipc-plugin
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-13
---

# IPC 通信与插件系统规范

> **适用于:** IPC 协议设计、IM Plugin 开发、CLI Plugin 开发
>
> ⚠️ **HARNESS 文件**: 本文档属于 Harness 架构，修改需谨慎

## IPC 通信协议

### Unix Socket 接口

**Socket 路径**: `~/.config/mm-coder/daemon.sock`（用户目录，权限 600）

**协议格式**: JSON 行（JSON Lines，newline-delimited JSON）

```
客户端发送: {"type":"command","name":"create","args":{...}}\n
服务端响应: {"type":"ok",...}\n
服务端响应: {"type":"error","message":"..."}\n
```

### IPC 命令清单

| 命令 | 类型 | 说明 |
|------|------|------|
| `create <name> [--workdir] [--cli]` | sync | 创建命名 session |
| `list` | sync | 列出所有 session |
| `remove <name>` | sync | 删除 session |
| `attach <name>` | sync | 启动 Claude Code 交互（终端模式）|
| `status` | sync | daemon 状态 + 所有 session 状态 |
| `stop` | sync | 停止 daemon |

### 错误响应格式

```typescript
interface ErrorResponse {
  type: 'error';
  message: string;       // 人类可读错误信息
  code?: string;          // 错误码（如 'SESSION_NOT_FOUND'）
}
```

## 插件接口

### IMPlugin 接口

```typescript
interface IncomingMessage {
  messageId: string;
  threadId: string;
  userId: string;
  content: string;
  timestamp: Date;
}

interface MessageTarget {
  threadId: string;
  channelId: string;
}

interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason?: string;
}

interface ApprovalResult {
  requestId: string;
  decision: 'approved' | 'denied' | 'expired' | 'cancelled';
}

interface IMPlugin {
  name: string;

  init(config: Record<string, unknown>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;

  // 消息处理
  onMessage(handler: (msg: IncomingMessage) => void): void;
  sendMessage(target: MessageTarget, content: string): Promise<void>;
  updateMessage(target: MessageTarget, messageId: string, content: string): Promise<void>;

  // Thread 管理
  createThread(channelId: string, sessionName: string): Promise<string>;

  // 权限审批
  requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<ApprovalResult>;
}
```

### CLIPlugin 接口

```typescript
interface Session {
  name: string;
  sessionId: string;
  cliPlugin: string;
  workdir: string;
  status: SessionStatus;
}

interface CLIEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'attachment' | 'last-prompt' | 'queue-operation';
}

interface CLIPlugin {
  name: string;

  // 终端模式：attach 时执行
  buildAttachCommand(session: Session): { command: string; args: string[] };

  // IM 模式：IM worker 启动命令
  buildIMWorkerCommand(session: Session): { command: string; args: string[] };

  // Session ID 管理
  generateSessionId(): string;
  validateSession(sessionId: string): Promise<boolean>;

  // Stream 解析（映射 stream-json → CLIEvent）
  parseStream(stdout: ReadableStream): AsyncIterable<CLIEvent>;
}
```

## 插件加载

### 配置文件

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
```

### 加载流程

```
daemon 启动
  → 读取 config.yaml
  → plugin-host.ts 动态 import IMPlugin 和 CLIPlugin
  → 调用 plugin.init(config)
  → 调用 plugin.start()
  → 注册 onMessage 回调
```

## MCP Permission Server

daemon 充当 MCP server，IM worker 通过 `--permission-prompt-tool mm-coder-permission` 连接。

### can_use_tool 请求处理

```
IM worker 调用工具
  → Claude Code sendRequest({subtype:"can_use_tool", tool_name, tool_input})
  → daemon MCP server 收到请求
  → ApprovalManager 查询 autoAllow/autoDeny 规则
    → 命中 autoAllow → 同步返回 {behavior:"allow"}
    → 命中 autoDeny  → 同步返回 {behavior:"deny"}
    → 未命中 → IMPlugin.requestApproval() → 等待 IM 用户响应
  → 返回 {behavior:"allow"|"deny"} 给 Claude Code
```

### 审批状态机

```
pending → approved  (用户同意)
pending → denied    (用户拒绝)
pending → expired   (超时 / daemon 重启)
pending → cancelled (用户取消)
```
