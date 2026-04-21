## 结论：**技术上完全可行**，但需要权衡产品设计

---

### Mattermost Channels API 能力分析

**`POST /api/v4/channels` — 创建公开/私有频道：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `team_id` | ✅ | 所属团队 ID |
| `name` | ✅ | 频道唯一标识（URL 中使用） |
| `display_name` | ✅ | UI 显示名称 |
| `type` | ✅ | `"O"`=公开, `"P"`=私有 |
| `purpose` | ❌ | 频道描述 |
| `header` | ❌ | Markdown 头部信息 |

**权限要求：**
- 创建公开频道 → `create_public_channel`
- 创建私有频道 → `create_private_channel`

---

### 当前 claude-threads 的 Thread 模型

```
同一个 Mattermost Channel (channelId)
├── Sticky Post（频道级，无 root_id）→ Session 列表入口
│   ├── Session A thread (root_id = Post-A)
│   │   ├── Reply 1
│   │   └── Reply 2
│   └── Session B thread (root_id = Post-B)
│       └── Reply 1
```

- **所有 session 共用一个 channel**，通过 thread 隔离
- Sticky post 是整个系统的"索引"，用户看到所有 session 列表
- 切换 session = 点击不同 thread

---

### 切换为 Channel 模型后的架构

```
同一个 Team
├── Channel: @user/claude-session-A  (session A)
│   └── 所有消息直接发在这里
├── Channel: @user/claude-session-B  (session B)
│   └── 所有消息直接发在这里
```

**关键区别：**

| 维度 | Thread 模型（现状） | Channel 模型（替代） |
|------|-------------------|-------------------|
| **隔离单位** | Thread（同一 channel 内） | Channel（独立空间） |
| **Session 列表** | Sticky post | 频道侧边栏 |
| **跨 session 切换** | 展开 thread | 切换频道 |
| **通知控制** | Thread 级 | Channel 级 |
| **Session 数量上限** | 受 thread 数量限制 | 受 channel 数量限制 |
| **成员管理** | 无（单 bot） | 无（单 bot） |
| **删除 session** | 删除 root post | Archiving channel |

---

### 可行的实现方式

**1. 每个 session 创建为 Private Channel（推荐）：**

```typescript
// 每次 startSession 时
const channel = await this.api<MattermostChannel>('POST', '/channels', {
  team_id: config.teamId,
  name: `claude-session-${sessionId.slice(0, 8)}`,
  display_name: `Claude Session — ${username}`,
  type: 'P',  // Private
  purpose: `Claude Threads session | Root: ${threadRootPostId}`,
  header: `Session started by @${username}`,
});
// 后续所有消息发送到 channel.id（不再需要 root_id）
await this.api('POST', '/posts', { channel_id: channel.id, message: "..." });
```

**2. 不需要 `team_id` 的场景 — Direct Message Channel：**

```typescript
// POST /api/v4/channels/direct — 两个用户之间的 DM
await this.api('POST', '/channels/direct', {
  // body: [userId1, userId2]  数组格式
});
```

但这只能两人 DM，不能满足 claude-threads 单 bot + 多 user 的场景。

---

### 核心权衡

| 优点 | 缺点 |
|------|------|
| ✅ 完全隔离，无 thread 嵌套复杂性 | ❌ 每 session 创建一个 channel，sidebar 会变长 |
| ✅ 天然支持 channel 级通知设置 | ❌ 用户需切换频道而非展开 thread |
| ✅ Session 历史是独立 channel，更清晰 | ❌ 删 session = archive channel，不够干净 |
| ✅ 无 sticky post 依赖，更稳定 | ❌ 需要 bot 有 `create_private_channel` 权限 |
| ✅ Channel 名可自定义（有意义的名字） | ❌ 不能在一个视图内看到所有 session |

---

### 最重要的前置问题

**Mattermost 频道是 `team` 级别的资源。** claude-threads 目前配置中只有 `channelId`（一个已存在的频道），没有 `teamId`。

要支持 channel 模型，需要新增配置：

```yaml
mattermost:
  channelId: "主频道（用于 session 索引）"
  teamId: "创建 session channel 的目标团队"   # ← 新增
```

**如果你的 Mattermost 部署中 bot 没有 `create_channel` 权限**，这条路就走不通——需要 Mattermost 管理员在权限配置中启用。

---

### 总结

| 问题 | 答案 |
|------|------|
| Mattermost API 支持创建 channel？ | ✅ `POST /api/v4/channels` |
| 能否替代 thread？ | **技术上可以**，每个 session 一个 private channel |
| 实际可行吗？ | **取决于**是否愿意管理 channel 数量膨胀，以及 bot 是否有 `create_channel` 权限 |
| 推荐程度 | ⭐⭐⭐ **中等** — thread 模型对多 session 管理更紧凑；channel 模型适合 session 长期独立运行的场景 |
