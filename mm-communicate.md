## 结论：Claude Code **启动一次，处理整个 session 的所有消息**

每个活跃 session 对应**一个** `ClaudeCli` 实例，进程只 spawn 一次，session 期间所有用户消息都通过该进程的 stdin/stdout 通信。

---

### 核心证据

**`src/claude/cli.ts` — `sendMessage()` 方法：**

```typescript
// Send a user message via JSON stdin
sendMessage(content: string | ContentBlock[]): void {
  if (!this.process?.stdin) throw new Error('Not running');
  const msg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content }
  }) + '\n';
  this.process.stdin.write(msg);   // ← 复用同一个进程
}
```

**一次启动 → 进程常驻：**

```typescript
start(): void {
  if (this.process) throw new Error('Already running');
  this.process = crossSpawn(claudePath, args, {
    cwd: this.options.workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],  // stdin/stdout/stderr 都保持连接
  });
  this.process.stdout?.on('data', (chunk) => {
    this.parseOutput(chunk.toString());  // ← 持续接收事件
  });
}
```

**每条消息复用同一个 Claude 进程** — `lifecycle.ts` 中的 `sendFollowUp()`：

```typescript
export async function sendFollowUp(session, message, files, ctx, ...) {
  if (!session.claude.isRunning()) return;
  // ...
  await session.messageManager.handleUserMessage(messageToSend, files, ...);
  // handleUserMessage 最终调用:
  // session.claude.sendMessage(content);   ← 发到同一个 stdin
}
```

---

### 通信模式总结

| 阶段 | 谁做主 | 做什么 |
|------|--------|--------|
| Session 启动 | Daemon | `new ClaudeCli()` → `claude.start()` spawn 一个子进程 |
| 用户发消息 | Daemon | `claude.sendMessage(JSON)` 写到 stdin |
| Claude 响应 | Claude 子进程 | stdout 输出 JSON events → `parseOutput()` → emit `event` |
| Daemon 处理事件 | Daemon | `messageManager.handleEvent()` 决定如何发帖/请求审批 |
| Session 结束 | 任意一方 | `claude.kill()` 或进程自行退出 → `handleExit()` 清理 |

所以 Claude Code 是**长驻进程模式**，不是"每条消息启动一次"。
