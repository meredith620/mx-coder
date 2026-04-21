现在我已经完整分析了源码，下面给你一个清晰的架构解析。

---

## OpenClaw "Typing Indicator" 机制 — 完整解析

### 核心问题

Mattermost 前端显示 "xxx is typing..." 是由 OpenClaw 周期性调用 **Mattermost `/users/me/typing` Web API** 实现的。这不是 WebSocket 的事件推送，而是客户端主动轮询发送的"我正在打字"信号。

---

### 关键文件

| 文件 | 作用 |
|------|------|
| `dist/typing-mS8FYd9W.js` | 核心状态机 — `createTypingCallbacks` |
| `dist/typing-start-guard-TEYNxaw3.js` | 防抖守卫 + keepalive 循环 |
| `dist/monitor-auth-7hHOzxRr.js` | Mattermost 具体实现：发 API |
| `dist/channel-reply-pipeline-BqQuVf4k.js` | 工厂函数 — 把 typing 配置变成 callback 对象 |
| `dist/dispatch-CFaSnCVe.js` | 把 typing 接入 reply dispatcher |

---

### 打字状态机 — `createTypingCallbacks` 的核心逻辑

```typescript
// typing-mS8FYd9W.js (src/channels/typing.ts)
createTypingCallbacks({
  start,           // 发送 typing 信号的函数 (Mattermost API)
  stop,            // 停止 typing 的函数
  onStartError,    // 发送失败回调
  keepaliveIntervalMs: 3000,  // 每 3 秒重发一次
  maxDurationMs: 60000         // 60s TTL，超时自动停
})
```

返回三个回调：
- **`onReplyStart`** — 回复开始时调用，启动打字指示
- **`onIdle`** — 回复完成时调用，停止打字指示
- **`onCleanup`** — 清理资源

### 生命周期详解

#### 1. `onReplyStart` 触发时序

```
用户发消息
    ↓
reply dispatcher 开始处理
    ↓
dispatcher.onReplyStart()  ← 被调用
    ↓
typingCallbacks.onReplyStart()
    ↓
startGuard.run(() => start())   ← 先调用一次
    ↓
sendMattermostTyping(client, { channelId })   ← POST /users/me/typing
    ↓
keepaliveLoop.start()   ← 启动定时器
    ↓
setInterval(每 3 秒) → fireStart() → start() → 再次 POST /users/me/typing
```

#### 2. `startGuard` — 防抖守卫

```typescript
// typing-start-guard-TEYNxaw3.js (src/channels/typing-start-guard.ts)
createTypingStartGuard({
  isSealed: () => closed,           // 已关闭则跳过
  maxConsecutiveFailures: 2,         // 连续失败 2 次就 "tripped"
  onTrip: () => keepaliveLoop.stop() // 失败太多次就停止 keepalive
})
```

防止在 typing 信号本身发送失败时还不断重试。

#### 3. `sendMattermostTyping` — 实际 API 调用

```typescript
// monitor-auth-7hHOzxRr.js (extensions/mattermost/src/mattermost/.../typing.ts)
async function sendMattermostTyping(client, params) {
  const payload = { channel_id: params.channelId };
  const parentId = params.parentId?.trim();
  if (parentId) payload.parent_id = parentId;
  await client.request("/users/me/typing", {  // Mattermost Web API
    method: "POST",
    body: JSON.stringify(payload)
  });
}
```

#### 4. TTL 超时保护

```typescript
// typing-mS8FYd9W.js
if (maxDurationMs <= 0) return;
ttlTimer = setTimeout(() => {
  console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping`);
  fireStop();  // 60s 后强制停止
}, maxDurationMs);
```

#### 5. `onIdle` 停止

```typescript
const fireStop = () => {
  closed = true;
  keepaliveLoop.stop();   // 停止定时器
  clearTtlTimer();        // 清除 TTL
  if (!stop || stopSent) return;
  stopSent = true;
  stop().catch(...);       // 发送停止信号 (Mattermost 协议里其实不需要显式停)
};
```

---

### 接入点 — Mattermost 消息处理的 wiring

```typescript
// monitor-auth-7hHOzxRr.js, handleSlashCommandAsync
const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
  cfg, agentId, channel: "mattermost", accountId,
  typing: {
    start: () => sendMattermostTyping(client, { channelId }),
    onStartError: (err) => logTypingFailure({ channel: "mattermost", target: channelId, error: err })
  }
});

const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
  ...replyPipeline,
  onReplyStart: typingCallbacks?.onReplyStart,   // ← 关键接入点
  ...
});
```

---

### 总结 — 完整数据流
```
Mattermost 收到用户消息 (Webhook/HTTP)
    ↓
OpenClaw 创建 typingCallbacks (via createChannelReplyPipeline)
    ↓
dispatchReplyFromConfig 开始处理回复
    ↓
onReplyStart() 被调用 (reply dispatcher 生命周期钩子)
    ↓
typingCallbacks.onReplyStart()
    ├─ startGuard.run(() => start())         ← 立即发一次 POST /users/me/typing
    ├─ keepaliveLoop.start()                  ← 启动 3s 间隔的定时器
    └─ set TTL timer (60s)
    ↓
每 3 秒: keepaliveLoop tick → fireStart() → start() → POST /users/me/typing
    ↓
回复内容分块送达 (sendBlockReply)
    ↓
全部送达后 → dispatcher.onIdle()
    ↓
typingCallbacks.onIdle() → fireStop() → keepaliveLoop.stop()
    ↓
Mattermost 前端不再显示 "xxx is typing..."
```

**核心要点：**
1. `sendMattermostTyping` 是标准的 **Mattermost Web API** 调用（`POST /users/me/typing`），不是 WebSocket 推送
2. 每 **3 秒**重发一次是通过 `setInterval` keepalive 循环实现的
3. **60 秒 TTL** 保护防止 typing 状态永远卡住
4. **防抖守卫（startGuard）** 防止 API 失败时疯狂重试
5. 整个 typing 生命周期由 reply dispatcher 的 `onReplyStart` / `onIdle` 钩子驱动
