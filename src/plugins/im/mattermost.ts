import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IMPlugin, ChannelStatusResult } from '../types.js';
import type { MessageTarget, MessageContent, IncomingMessage, ApprovalRequest, IMConfigGuide } from '../../types.js';

export interface MattermostConfig {
  url: string;
  token: string;
  channelId: string;
  spaceStrategy?: 'thread' | 'channel';
  teamId?: string;
  /** Bot user ID, resolved during connect() */
  botUserId?: string;
  /** WebSocket reconnect interval in ms (default: 5000) */
  reconnectIntervalMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeReactionEmoji(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const emoji = value.trim();
  if (emoji === '+1') return '👍';
  if (emoji === 'white_check_mark') return '✅';
  if (emoji === '-1') return '👎';
  if (emoji === 'stop_button') return '⏹️';
  return emoji;
}

function requireNonEmptyString(value: unknown, fieldName: string, configPath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Mattermost config field '${fieldName}' is required in ${configPath}`);
  }
  return value;
}

/** Default config path: ~/.mx-coder/config.json */
export function getDefaultMattermostConfigPath(): string {
  return path.join(os.homedir(), '.mx-coder', 'config.json');
}

export function ensureMattermostConfigDir(configPath = getDefaultMattermostConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
}

export function getMattermostConfigGuide(configPath = getDefaultMattermostConfigPath()): IMConfigGuide {
  return {
    plugin: 'mattermost',
    configPath,
    example: {
      im: {
        mattermost: {
          url: 'https://your-mattermost-server.example.com',
          token: 'your-bot-token-here',
          channelId: 'your-channel-id-here',
          spaceStrategy: 'thread',
          reconnectIntervalMs: 5000,
        },
      },
    },
  };
}

export function writeMattermostConfigTemplate(configPath = getDefaultMattermostConfigPath()): void {
  ensureMattermostConfigDir(configPath);
  if (fs.existsSync(configPath)) {
    throw new Error(`Config already exists: ${configPath}`);
  }

  const guide = getMattermostConfigGuide(configPath);
  fs.writeFileSync(`${configPath}`, `${JSON.stringify(guide.example, null, 2)}\n`, 'utf-8');
}

export function loadMattermostConfig(configPath = getDefaultMattermostConfigPath()): MattermostConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Mattermost config file not found: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  } catch (err) {
    throw new Error(`Failed to parse Mattermost config: ${(err as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid Mattermost config format in ${configPath}`);
  }

  const im = parsed['im'];
  const raw = isRecord(im) && isRecord((im as Record<string, unknown>)['mattermost'])
    ? (im as Record<string, unknown>)['mattermost'] as Record<string, unknown>
    : undefined;
  if (!raw) {
    throw new Error(`Mattermost config must use {"im":{"mattermost":{...}}} format in ${configPath}`);
  }

  const url = requireNonEmptyString(raw['url'], 'url', configPath);
  const token = requireNonEmptyString(raw['token'], 'token', configPath);
  const channelId = requireNonEmptyString(raw['channelId'], 'channelId', configPath);

  const reconnectRaw = raw['reconnectIntervalMs'];
  let reconnectIntervalMs: number | undefined;
  if (reconnectRaw !== undefined) {
    if (typeof reconnectRaw !== 'number' || !Number.isFinite(reconnectRaw) || reconnectRaw <= 0) {
      throw new Error(`Mattermost config field 'reconnectIntervalMs' must be a positive number in ${configPath}`);
    }
    reconnectIntervalMs = reconnectRaw;
  }

  const spaceStrategyRaw = raw['spaceStrategy'];
  let spaceStrategy: 'thread' | 'channel' | undefined;
  if (spaceStrategyRaw !== undefined) {
    if (spaceStrategyRaw !== 'thread' && spaceStrategyRaw !== 'channel') {
      throw new Error(`Mattermost config field 'spaceStrategy' must be 'thread' or 'channel' in ${configPath}`);
    }
    spaceStrategy = spaceStrategyRaw;
  }

  const teamIdRaw = raw['teamId'];
  let teamId: string | undefined;
  if (teamIdRaw !== undefined) {
    teamId = requireNonEmptyString(teamIdRaw, 'teamId', configPath);
  }
  if (spaceStrategy === 'channel' && !teamId) {
    throw new Error(`Mattermost config field 'teamId' is required when spaceStrategy=channel in ${configPath}`);
  }

  return {
    url,
    token,
    channelId,
    ...(spaceStrategy !== undefined ? { spaceStrategy } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
    ...(reconnectIntervalMs !== undefined ? { reconnectIntervalMs } : {}),
  };
}

export function getMattermostCommandHelpText(cliPluginName?: string, supportedNativeCommands?: string[]): string {
  const lines = [
    '**mx-coder 可用命令**：',
    '',
    '`/help` — 显示本帮助',
    '`/list` — 列出所有 mx-coder session 及绑定空间',
    '`/status` — 显示当前 session 状态（在会话空间中）或全局统计（在主频道）',
    '`/open <sessionName>` — 为未绑定 session 创建独立会话空间；已有绑定则跳转到对应空间',
    '`/stream` — 查看当前会话输出模式；`/stream normal|thinking|verbose` 可切换',
    '`/takeover <sessionName>` — 请求接管当前被终端占用的会话',
    '`/takeover-force <sessionName>` — 立即强制接管当前被终端占用的会话',
    '',
  ];

  // Add CLI-specific passthrough commands
  if (supportedNativeCommands && supportedNativeCommands.length > 0) {
    const cliLabel = cliPluginName ? `**${cliPluginName}** 原生命令` : 'Claude Code 原生命令';
    lines.push(`${cliLabel}（使用 \`//<cmd>\` 透传）：`);
    // Format commands in rows of 3 for readability
    const cmdRows: string[] = [];
    for (let i = 0; i < supportedNativeCommands.length; i += 3) {
      const row = supportedNativeCommands.slice(i, i + 3).map(c => `\`${c}\``).join('  ');
      cmdRows.push(row);
    }
    lines.push(...cmdRows);
    lines.push('');
  }

  lines.push(
    '在 thread 或 session channel 中发送普通文本消息将交给 Claude 处理。若会话正被终端占用，消息会被拒绝并提示使用 takeover。',
    '`/remove`、`/attach`、`/create` 等 session 管理命令请在 CLI 中使用。',
  );

  return lines.join('\n');
}

export function getMattermostWelcomeText(username: string, sessionCount: number, activeCount: number): string {
  return [
    `**mx-coder** 已连接 (\`${username}\`)`,
    `当前会话：${sessionCount} 个，活跃中：${activeCount} 个`,
    '发送 `/help` 查看可用命令。',
  ].join('\n');
}

/**
 * Convenience helper: load config file, create plugin, connect and validate token.
 */
export async function createConnectedMattermostPlugin(
  configPath?: string,
  connectOpts: { sessionCount?: number; activeCount?: number } = {},
): Promise<MattermostPlugin> {
  const plugin = new MattermostPlugin(loadMattermostConfig(configPath));
  await plugin.connect(connectOpts);
  return plugin;
}

export async function verifyMattermostConnection(configPath?: string): Promise<{
  ok: true;
  config: MattermostConfig;
  botUserId: string;
}> {
  const plugin = await createConnectedMattermostPlugin(configPath);
  try {
    return {
      ok: true,
      config: plugin.getConfig(),
      botUserId: plugin.getBotUserId(),
    };
  } finally {
    await plugin.disconnect();
  }
}


/**
 * MattermostPlugin — connects to Mattermost via REST API (posts) and WebSocket (events).
 *
 * Lifecycle:
 *   1. new MattermostPlugin(config)
 *   2. await plugin.connect()  ← validates token, resolves botUserId, starts WebSocket
 *   3. plugin.onMessage(handler) to receive incoming messages
 *   4. await plugin.disconnect() on shutdown
 */
export class MattermostPlugin implements IMPlugin {
  private _config: MattermostConfig;
  private _handlers: Array<(msg: IncomingMessage) => void> = [];
  private _ws: WebSocket | null = null;
  private _botUserId: string | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _stopped = false;
  private _lastWsOpenAt = 0;
  private _lastWsMessageAt = 0;
  private _lastHeartbeatSentAt = 0;
  private _lastHeartbeatAckAt = 0;
  private _lastHeartbeatSeq: number | null = null;
  private _wsHealthy = false;
  private _subscriptionHealthy = false;
  private _listenedChannels = new Set<string>();

  constructor(config: MattermostConfig) {
    this._config = config;
    this._listenedChannels.add(config.channelId);
  }

  /**
   * Validate token by fetching /api/v4/users/me, then start WebSocket listener.
   * Throws if token is invalid or server unreachable.
   */
  async connect(opts: { sessionCount?: number; activeCount?: number } = {}): Promise<void> {
    const me = await this._apiGet<{ id: string; username: string }>('/api/v4/users/me');
    this._botUserId = me.id;
    this._stopped = false;
    this._startWebSocket();

    // Send welcome message (non-fatal if it fails, e.g. channel was deleted)
    try {
      await this.sendMessage(
        { plugin: 'mattermost', channelId: this._config.channelId, threadId: '' },
        { kind: 'text', text: getMattermostWelcomeText(me.username, opts.sessionCount ?? 0, opts.activeCount ?? 0) },
      );
    } catch (err) {
      // Log warning but don't fail - the channel might be deleted or inaccessible
      console.warn(`[Mattermost] Failed to send welcome message to channel ${this._config.channelId}: ${(err as Error).message}`);
    }
  }

  /** Graceful shutdown: stop WebSocket reconnect loop and close connection */
  async disconnect(): Promise<void> {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  getBotUserId(): string {
    if (!this._botUserId) {
      throw new Error('Mattermost plugin is not connected');
    }
    return this._botUserId;
  }

  getConfig(): MattermostConfig {
    return { ...this._config };
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this._handlers.push(handler);
  }

  addListenedChannel(channelId: string): void {
    this._listenedChannels.add(channelId);
  }

  getConnectionHealth(): {
    wsHealthy: boolean;
    subscriptionHealthy: boolean;
    lastWsOpenAt: number;
    lastWsMessageAt: number;
    lastHeartbeatSentAt: number;
    lastHeartbeatAckAt: number;
  } {
    return {
      wsHealthy: this._wsHealthy,
      subscriptionHealthy: this._subscriptionHealthy,
      lastWsOpenAt: this._lastWsOpenAt,
      lastWsMessageAt: this._lastWsMessageAt,
      lastHeartbeatSentAt: this._lastHeartbeatSentAt,
      lastHeartbeatAckAt: this._lastHeartbeatAckAt,
    };
  }

  private _debugLog(payload: Record<string, unknown>): void {
    try {
      const debugPath = process.env.MM_CODER_MM_DEBUG_LOG;
      if (!debugPath) return;
      fs.mkdirSync(path.dirname(debugPath), { recursive: true });
      fs.appendFileSync(debugPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, 'utf-8');
    } catch {
      // ignore debug logging failure
    }
  }

  private _formatApprovalMessage(request: ApprovalRequest): string {
    return [
      `**Approval required** — \`${request.toolName}\``,
      `风险：${request.riskLevel}　能力：${request.capability}`,
      request.toolInputSummary,
      '',
      '| 选项 | Emoji | Fallback |',
      '|---|---|---|',
      '| approve once | 👍 | `/approve once` |',
      '| approve session | ✅ | `/approve session` |',
      '| deny | 👎 | `/deny` |',
      '| cancel | ⏹️ | `/cancel` |',
    ].join('\n');
  }

  private _headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this._config.token}`,
      'Content-Type': 'application/json',
    };
  }

  private _toText(content: MessageContent): string {
    if (content.kind === 'text') return content.text;
    if (content.kind === 'markdown') return content.markdown;
    return content.url;
  }

  private async _apiRequest(path: string, init: { method: 'GET' | 'POST' | 'PUT'; body?: string }): Promise<Response> {
    const res = await fetch(`${this._config.url}${path}`, {
      method: init.method,
      headers: this._headers(),
      ...(init.body ? { body: init.body } : {}),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Mattermost API error ${res.status}: ${body}`);
    }

    return res;
  }

  private async _apiGet<T>(path: string): Promise<T> {
    const res = await this._apiRequest(path, { method: 'GET' });
    return res.json() as Promise<T>;
  }

  /**
   * Check if a channel exists and is not deleted.
   * Returns null if the channel is valid, or an object with error info if not.
   */
  async checkChannelStatus(channelId: string): Promise<ChannelStatusResult> {
    try {
      const channel = await this._apiGet<{ id: string; delete_at: number }>(`/api/v4/channels/${channelId}`);
      if (channel.delete_at > 0) {
        return { kind: 'deleted', error: 'Channel has been deleted' };
      }
      return { kind: 'ok' };
    } catch (err) {
      const error = (err as Error).message;
      if (error.includes(' 403:')) {
        return { kind: 'forbidden', error };
      }
      if (error.includes(' 404:')) {
        return { kind: 'not_found', error };
      }
      return { kind: 'unknown_error', error };
    }
  }

  /** Start WebSocket connection to receive real-time events */
  private _startWebSocket(): void {
    if (this._stopped) return;

    const wsUrl = this._config.url.replace(/^https?:\/\//, (m) =>
      m.startsWith('https') ? 'wss://' : 'ws://',
    ) + '/api/v4/websocket';

    const ws = new WebSocket(wsUrl);
    this._ws = ws;
    this._wsHealthy = false;
    this._subscriptionHealthy = false;

    ws.addEventListener('open', () => {
      this._lastWsOpenAt = Date.now();
      this._wsHealthy = true;
      this._startHeartbeat();
      ws.send(JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token: this._config.token },
      }));
    });

    ws.addEventListener('message', (event) => {
      this._lastWsMessageAt = Date.now();
      this._subscriptionHealthy = true;
      this._handleWsMessage(event.data as string);
    });

    ws.addEventListener('close', () => {
      this._ws = null;
      this._wsHealthy = false;
      this._subscriptionHealthy = false;
      if (this._heartbeatTimer) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
      if (!this._stopped) {
        const interval = this._config.reconnectIntervalMs ?? 5000;
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this._startWebSocket();
        }, interval);
      }
    });

    ws.addEventListener('error', () => {
      // Errors are followed by close event, handled there
    });
  }

  private _startHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
    }

    const interval = this._config.heartbeatIntervalMs ?? 5000;
    const timeout = this._config.heartbeatTimeoutMs ?? interval * 3;

    this._heartbeatTimer = setInterval(() => {
      if (!this._ws) return;

      const now = Date.now();
      this._lastHeartbeatSentAt = now;
      this._lastHeartbeatSeq = now;
      try {
        this._ws.send(JSON.stringify({ seq: now, action: 'ping' }));
      } catch {
        this._forceReconnect();
        return;
      }

      const lastActivity = Math.max(this._lastWsMessageAt, this._lastHeartbeatAckAt, this._lastWsOpenAt);
      if (now - lastActivity > timeout) {
        this._forceReconnect();
      }
    }, interval);
  }

  private _forceReconnect(): void {
    if (!this._ws) return;
    try {
      this._ws.close();
    } catch {
      // ignore
    }
  }

  private _handleWsMessage(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof event.seq_reply === 'number' && event.seq_reply === this._lastHeartbeatSeq) {
      this._lastHeartbeatAckAt = Date.now();
    }

    if (event.event === 'reaction_added' || event.event === 'reaction_removed') {
      const reactionData = event.data as Record<string, unknown> | undefined;
      const broadcast = event.broadcast as Record<string, unknown> | undefined;
      const channelId = (reactionData?.channel_id as string | undefined) ?? (broadcast?.channel_id as string | undefined);
      if (channelId !== this._config.channelId) return;
      const postId = (reactionData?.post_id as string | undefined) ?? (broadcast?.post_id as string | undefined);
      const userId = (reactionData?.user_id as string | undefined) ?? (broadcast?.user_id as string | undefined);
      const emoji = normalizeReactionEmoji((reactionData?.emoji_name as unknown) ?? (broadcast?.emoji_name as unknown));
      if (!postId || !userId || !emoji) return;
      if (userId === this._botUserId) return;

      const incomingReaction = {
        action: event.event === 'reaction_added' ? 'added' : 'removed',
        emoji,
        postId,
      } as const;
      const incoming: IncomingMessage = {
        messageId: `${postId}:${userId}:${emoji}:${event.event}`,
        plugin: 'mattermost',
        channelId,
        threadId: postId,
        isTopLevel: false,
        userId,
        text: '',
        createdAt: new Date().toISOString(),
        dedupeKey: `${postId}:${userId}:${emoji}:${event.event}`,
        reaction: incomingReaction,
      };
      this._debugLog({ event: 'ws_reaction', channelId, postId, userId, emoji, action: incomingReaction.action });
      for (const h of this._handlers) h(incoming);
      return;
    }

    if (event.event !== 'posted') return;

    const data = event.data as Record<string, unknown> | undefined;
    if (!data) return;

    let post: Record<string, unknown>;
    try {
      post = JSON.parse(data.post as string) as Record<string, unknown>;
    } catch {
      return;
    }

    if (post.user_id === this._botUserId) return;

    const channelId = post.channel_id as string | undefined;
    if (!channelId || !this._listenedChannels.has(channelId)) return;

    const incoming: IncomingMessage = {
      messageId: post.id as string,
      plugin: 'mattermost',
      channelId: channelId,
      threadId: (post.root_id as string | undefined) || (post.id as string),
      isTopLevel: !(post.root_id as string | undefined),
      userId: post.user_id as string,
      text: post.message as string,
      createdAt: new Date(Number(post.create_at)).toISOString(),
      dedupeKey: post.id as string,
    };

    this._debugLog({
      event: 'ws_posted',
      channelId,
      rootId: post.root_id as string | undefined,
      postId: post.id as string,
      isTopLevel: incoming.isTopLevel,
    });

    for (const h of this._handlers) h(incoming);
  }

  async sendMessage(target: MessageTarget, content: MessageContent): Promise<void> {
    const body = {
      channel_id: target.channelId ?? this._config.channelId,
      ...(target.threadId ? { root_id: target.threadId } : {}),
      message: this._toText(content),
    };
    this._debugLog({ event: 'sendMessage', body });
    await this._apiRequest('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async createLiveMessage(target: MessageTarget, content: MessageContent): Promise<string> {
    const body = {
      channel_id: target.channelId ?? this._config.channelId,
      ...(target.threadId ? { root_id: target.threadId } : {}),
      message: this._toText(content),
    };
    this._debugLog({ event: 'createLiveMessage_request', body });
    const res = await this._apiRequest('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json() as { id: string };
    this._debugLog({ event: 'createLiveMessage_response', response: data });
    return data.id;
  }

  async createChannelConversation(input: { channelId: string; teamId: string; isPrivate: boolean; userId?: string; sessionName?: string }): Promise<string> {
    const baseName = input.sessionName || 'session';
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const displayTimestamp = now.toISOString().slice(0, 16).replace('T', ' ');
    const suffix = Math.random().toString(36).slice(2, 6);

    const name = `mx-${baseName}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    const channelName = `${name || 'mx-session'}-${timestamp}-${suffix}`.slice(0, 64);
    const displayName = `mx-coder: ${baseName} [${displayTimestamp}]`.slice(0, 64);

    const res = await this._apiRequest('/api/v4/channels', {
      method: 'POST',
      body: JSON.stringify({
        team_id: input.teamId,
        name: channelName,
        display_name: displayName,
        purpose: `mx-coder session space for ${baseName}`,
        type: input.isPrivate ? 'P' : 'O',
      }),
    });
    const data = await res.json() as { id: string };
    const newChannelId = data.id;

    // Add bot to the channel
    const botUserId = this.getBotUserId();
    await this._apiRequest(`/api/v4/channels/${newChannelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: botUserId }),
    });

    // Add requesting user to the channel if provided
    if (input.userId && input.userId !== botUserId) {
      await this._apiRequest(`/api/v4/channels/${newChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: input.userId }),
      });
    }

    // Register this channel for listening
    this._listenedChannels.add(newChannelId);

    return newChannelId;
  }

  async updateMessage(messageId: string, content: MessageContent): Promise<void> {
    await this._apiRequest(`/api/v4/posts/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: messageId,
        message: this._toText(content),
      }),
    });
  }

  async sendTyping(target: MessageTarget): Promise<void> {
    const userId = this.getBotUserId();
    await this._apiRequest(`/api/v4/users/${userId}/typing`, {
      method: 'POST',
      body: JSON.stringify({
        channel_id: target.channelId ?? this._config.channelId,
        ...(target.threadId ? { parent_id: target.threadId } : {}),
      }),
    });
  }

  async addReactions(messageId: string, emojis: string[]): Promise<void> {
    const userId = this.getBotUserId();
    for (const emoji of emojis) {
      const emoji_name = emoji === '👍' ? '+1'
        : emoji === '✅' ? 'white_check_mark'
        : emoji === '👎' ? '-1'
        : emoji === '⏹️' ? 'stop_button'
        : emoji;
      await this._apiRequest('/api/v4/reactions', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, post_id: messageId, emoji_name }),
      });
    }
  }

  async listReactions(messageId: string): Promise<Array<{ userId: string; emoji: string }>> {
    const res = await this._apiGet<Array<{ user_id?: string; emoji_name?: string }>>(`/api/v4/posts/${messageId}/reactions`);
    return res
      .filter((item) => typeof item.user_id === 'string' && typeof item.emoji_name === 'string' && item.user_id !== this._botUserId)
      .map((item) => ({ userId: item.user_id!, emoji: normalizeReactionEmoji(item.emoji_name) ?? item.emoji_name! }));
  }

  async requestApproval(target: MessageTarget, request: ApprovalRequest): Promise<string | undefined> {
    const message = this._formatApprovalMessage(request);
    const res = await this._apiRequest('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify({
        channel_id: target.channelId ?? this._config.channelId,
        root_id: target.threadId,
        message,
        props: {
          attachments: [{
            title: `Tool: ${request.toolName}`,
            text: message,
            color: request.riskLevel === 'high' ? '#FF0000' : request.riskLevel === 'medium' ? '#FFA500' : '#00FF00',
          }],
        },
      }),
    });
    const data = await res.json() as { id?: string };
    if (data.id) {
      await this.addReactions(data.id, ['👍', '✅', '👎', '⏹️']);
    }
    return data.id;
  }
}
