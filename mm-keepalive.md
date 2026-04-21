现在我对整个机制有了完整的理解。以下是深度解析：

---

## Mattermost 插件 WebSocket 保活机制 — 全解析

### 核心文件

| 文件 | 职责 |
|------|------|
| `channel.runtime-DgWCXhbr.js` | Mattermost WebSocket 客户端全部实现 |
| `monitor-auth-7hHOzxRr.js` | Mattermost API 客户端（REST） |

---

### 架构概览：三层保活

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: runWithReconnect (外层重连循环)                  │
│  指数退避 + jitter, 无限重试直到 abort                     │
└────────────────────┬────────────────────────────────────┘
                     │ 调用 connectOnce
┌────────────────────▼────────────────────────────────────┐
│  Layer 2: createMattermostConnectOnce (单次连接)            │
│  WebSocket 生命周期 + health check + auth                 │
└────────────────────┬────────────────────────────────────┘
                     │ ws.on("close") / ws.on("error")
┌────────────────────▼────────────────────────────────────┐
│  Layer 3: WebSocket 协议层 (Mattermost 服务端)             │
│  TCP keepalive + ws ping/pong (服务端自动处理)             │
└─────────────────────────────────────────────────────────┘
```

---

### Layer 1: 重连循环 — 指数退避

```typescript
// channel.runtime-DgWCXhbr.js, src/mattermost/reconnect.ts
async function runWithReconnect(connectFn, opts = {}) {
  const { initialDelayMs = 2000, maxDelayMs = 60000 } = opts;
  const jitterRatio = 0.2;   // ±20% 随机抖动
  let retryDelay = initialDelayMs;

  while (!opts.abortSignal?.aborted) {
    try {
      await connectFn();          // 连接正常关闭 → resolve → 重置退避
      retryDelay = initialDelayMs; // 退避重置
    } catch (err) {
      // 连接失败 → 需要重连
      shouldIncreaseDelay = true;
    }
    const delayMs = withJitter(retryDelay, jitterRatio, Math.random);
    await sleepAbortable(delayMs, opts.abortSignal);
    if (shouldIncreaseDelay) {
      retryDelay = Math.min(retryDelay * 2, maxDelayMs); // 翻倍,上限 60s
    }
    attempt++;
  }
}
```

**关键参数：**
- 初始延迟：`2000ms`
- 最大延迟：`60000ms`（60秒）
- 抖动比例：±20%（防止多实例同时重连）
- 重连条件：仅在 `outcome === "rejected"` 时重连（异常断开）

**调用处：**
```javascript
// channel.runtime-DgWCXhbr.js:1919
await runWithReconnect(connectOnce, {
  abortSignal: opts.abortSignal,
  jitterRatio: .2,
  onError: (err) => runtime.error?.(`mattermost connection failed: ${err}`),
  onReconnect: (delayMs) => runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs/1e3)}s`)
});
```

---

### Layer 2: 单次连接 — 完整生命周期

```typescript
// channel.runtime-DgWCXhbr.js:509, createMattermostConnectOnce
const ws = webSocketFactory(opts.wsUrl);  // new WebSocket(url)

// ── Abort 信号清理 ──
const onAbort = () => ws.terminate();  // abort 时强制断开
opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

// ── WebSocket 打开 ──
ws.on("open", () => {
  opened = true;
  statusSink?.({ connected: true, lastConnectedAt: Date.now(), lastError: null });
  
  // 发送认证挑战 (Mattermost WebSocket 协议要求)
  ws.send(JSON.stringify({
    seq: opts.nextSeq(),
    action: "authentication_challenge",
    data: { token: opts.botToken }
  }));
  
  // 启动健康检查
  if (getBotUpdateAt) runHealthCheck();
});

// ── 收到消息 ──
ws.on("message", async (data) => {
  const payload = parseMattermostEventPayload(rawDataToString(data));
  if (!payload) return;
  
  if (payload.event === "posted") {
    debouncer.enqueue({ post, payload });  // 入站消息去重+合并
  }
  if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
    onReaction?.(payload);
  }
});

// ── 连接关闭 ──
ws.on("close", (code, reason) => {
  stopHealthChecks();
  statusSink?.({ connected: false, lastDisconnect: { at: Date.now(), status: code } });
  
  if (opened) {
    resolveOnce();   // 正常关闭 → resolve → runWithReconnect 退出循环
  } else {
    rejectOnce(new WebSocketClosedBeforeOpenError(...)); // 未打开就断了 → reject → 触发重连
  }
});

// ── 错误处理 ──
ws.on("error", (err) => {
  runtime.error?.(`mattermost websocket error: ${err}`);
  try { ws.close(); } catch {}
});
```

**注意**：`opened` 标志是区分"正常关闭"和"异常断开"的关键：
- 如果 WebSocket 在 `open` 事件触发之前就关闭了（服务器拒绝连接等）→ 触发重连
- 如果是正常运行中服务器主动关闭（`opened=true`）→ 退出重连循环

---
### Layer 3: Bot Account 健康检查（主动检测）

```typescript
// healthCheckIntervalMs = 30000 (30秒)
const runHealthCheck = async () => {
  healthCheckInFlight = true;
  try {
    const current = await getBotUpdateAt();  // GET /users/me → update_at
    
    if (initialUpdateAt === void 0) {
      initialUpdateAt = current;  // 记录初始值
      return;
    }
    
    if (current !== initialUpdateAt) {
      // Bot 账号被修改了！需要重连
      runtime.log?.(`mattermost: bot account updated — reconnecting`);
      ws.terminate();  // 强制断开，触发重连
    }
  } catch (err) {
    runtime.error?.(`mattermost: health check error: ${err}`);
  } finally {
    healthCheckInFlight = false;
    scheduleHealthCheck();  // 30s 后再检查
  }
};
```

**作用**：检测 Bot 账号本身被修改（如 token 被轮换）的情况，这是比网络断开更隐蔽的失效模式。

---

### 入站消息去重 + 合并

```typescript
// channel.runtime-DgWCXhbr.js:1849
const debouncer = core.channel.debounce.createInboundDebouncer({
  debounceMs: inboundDebounceMs,
  buildKey: (entry) => {
    // 按 channelId + threadId 聚合
    return `mattermost:${account.accountId}:${channelId}:${threadKey}`;
  },
  shouldDebounce: (entry) => {
    // 有文件/空消息/控制命令 → 不合并
    if (entry.post.file_ids?.length > 0) return false;
    if (!entry.post.message) return false;
    return !core.channel.text.hasControlCommand(entry.post.message, cfg);
  },
  onFlush: async (entries) => {
    if (entries.length === 1) {
      await handlePost(entries[0].post, entries[0].payload);
    } else {
      // 多条快速消息合并为一条
      const combinedText = entries.map(e => e.post.message).join("\n");
      await handlePost({ ...lastPost, message: combinedText, file_ids: [] });
    }
  }
});
```

---

### Abort 信号（优雅关闭）

```typescript
// 任何层收到 abort 信号
const onAbort = () => ws.terminate();  // 强制 TCP 断开
opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

// finally: 清理监听器
finally {
  opts.abortSignal?.removeEventListener("abort", onAbort);
}
```

---

### 总结 — 时序图

```
启动 monitorMattermostProvider()
    ↓
runWithReconnect(connectOnce)  ← 外层重连循环
    ↓
createMattermostConnectOnce()
    ├─ new WebSocket("wss://<server>/api/v4/websocket")
    ├─ ws.on("open")  →  发送 authentication_challenge
    │                  启动 30s 一次 healthCheck (轮询 /users/me)
    ├─ ws.on("message") → posted 事件 → debouncer → handlePost
    │                  reaction 事件 → handleReactionEvent
    ├─ ws.on("close")  → opened=true  → resolve() (正常退出)
    │                  → opened=false → reject() (异常 → 触发重连)
    └─ ws.on("error") → runtime.error + ws.close()

    断开时:
    runWithReconnect 捕获 reject
        ↓
    withJitter(retryDelay, 0.2)  →  sleep
        ↓
    retryDelay = min(retryDelay * 2, 60000)  (指数退避)
        ↓
    再次调用 connectOnce (重连)
        ↓
    正常关闭 → resolve() → 退避重置为 2000ms
```

**没有 `ws.ping()` / `ws.pong()`**：Mattermost 服务器端自动处理 WebSocket 协议层的 ping/pong（RFC 6455），客户端不需要手动发送。应用层的保活完全依赖**重连循环 + health check**实现。
