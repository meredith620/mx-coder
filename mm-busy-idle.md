## 1. Claude Code 启动参数

**来源：`src/claude/cli.ts` 的 `start()` 方法：**

```typescript
const args = [
  '--input-format', 'stream-json',   // ← JSON 流格式输入
  '--output-format', 'stream-json',  // ← JSON 流格式输出
  '--verbose',
];
```

**关键参数解析：**

| 参数 | 作用 |
|------|------|
| `--input-format stream-json` | 允许通过 stdin 以 JSON Lines 格式发送消息 |
| `--output-format stream-json` | 输出为 JSON Lines 流（每个 JSON 对象一行） |
| `--session-id <uuid>` | 指定会话 ID，保持会话连续性 |
| `--resume <session-id>` | 恢复已有会话（重启后接续） |
| `--mcp-config <json>` | 注入 MCP permission server 配置 |
| `--append-system-prompt <text>` | 追加系统提示词（claude-threads 的平台上下文） |
| `--settings <json>` | 配置 status line 写入文件（用于 token 用量追踪） |
| `--dangerously-skip-permissions` | 跳过权限提示（若启用） |
| `--chrome` | Chrome 集成 |

**stdio 通信方式：**

```typescript
this.process = crossSpawn(claudePath, args, {
  cwd: this.options.workingDir,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],  // ← stdin/stdout/stderr 全为 pipe（非 TTY）
});
```

发送消息格式：
```typescript
// 每次 sendMessage()
const msg = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: "..." }
}) + '\n';
process.stdin.write(msg);
```

接收事件格式：
```typescript
// 每个 JSON 对象是一行事件
process.stdout.on('data', (chunk) => {
  this.parseOutput(chunk.toString());  // 按 '\n' 分割，每行 JSON.parse
});
```

---

## 2. 忙闲判断：Claude Code **没有**提供状态查询接口，完全是外部推断

**Claude Code 提供的唯一状态通道是事件流（`event.type`）：**

| 事件类型 | 含义 | claude-threads 用它做什么 |
|----------|------|--------------------------|
| `assistant` | Claude 开始输出 | 首次收到 → `hasClaudeResponded = true` |
| `tool_use` | Claude 正在执行工具 | 首次收到有意义内容 → 标记为活跃 |
| `tool_result` | 工具执行结果返回 | 追踪是否有错误 |
| `result` | 一次响应周期结束 | **`isProcessing = false`**（关键信号）|
| `system` (subtype=`init`) | 初始化完成 | 捕获可用 slash commands |
| `system` (subtype=`error`) | 系统错误 | 追踪错误状态 |
| `system` (subtype=`compacting`) | 上下文压缩中 | 处理压缩状态 |

**结论：Claude Code 是一个纯事件发射器，没有提供任何驻留状态查询 API（如 `isBusy()`、`getStatus()` 这类接口）。** claude-threads 的 `isProcessing` 完全是基于上述事件流**自己维护的布尔标志**：

```typescript
// claude-threads 自己维护
session.isProcessing = true   // 用户发消息时
session.isProcessing = false  // 收到 result 事件时
```

**typing indicator 同样是外部特征**：它不是 Claude Code 的状态 API，而是当 `isProcessing = true` 时，claude-threads 自己调用 `session.platform.sendTyping()` 向 Mattermost/Slack 发送 "user is typing" 信号——这和 Claude Code 本身无关。

**简单说：Claude Code 只管输出事件，不管状态查询。** 所有 busy/idle 的判断都是 claude-threads 根据事件流自己推断出来的。
