import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IMPlugin } from '../types.js';
import type { MessageTarget, MessageContent, IncomingMessage, ApprovalRequest, IMConfigGuide } from '../../types.js';

export interface MattermostConfig {
  url: string;
  token: string;
  channelId: string;
  /** Bot user ID, resolved during connect() */
  botUserId?: string;
  /** WebSocket reconnect interval in ms (default: 5000) */
  reconnectIntervalMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireNonEmptyString(value: unknown, fieldName: string, configPath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Mattermost config field '${fieldName}' is required in ${configPath}`);
  }
  return value;
}

/** Default config path: ~/.mm-coder/config.json */
export function getDefaultMattermostConfigPath(): string {
  return path.join(os.homedir(), '.mm-coder', 'config.json');
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

  // Support three config formats:
  // 1. { "im": { "mattermost": { url, token, channelId } } }  (new multi-IM format)
  // 2. { "mattermost": { url, token, channelId } }            (grouped format)
  // 3. { url, token, channelId }                               (flat format)
  const raw = isRecord(parsed['im']) && isRecord((parsed['im'] as Record<string, unknown>)['mattermost'])
    ? (parsed['im'] as Record<string, unknown>)['mattermost'] as Record<string, unknown>
    : isRecord(parsed['mattermost'])
      ? parsed['mattermost']
      : parsed;

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

  return {
    url,
    token,
    channelId,
    ...(reconnectIntervalMs !== undefined ? { reconnectIntervalMs } : {}),
  };
}

export function getMattermostCommandHelpText(): string {
  return [
    '**mm-coder 可用命令**：',
    '',
    '`/help` — 显示本帮助',
    '`/list` — 列出所有 mm-coder session 及绑定 thread',
    '`/status` — 显示当前 session 状态（在 thread 中）或全局统计（在主频道）',
    '`/open <sessionName>` — 为未绑定 session 创建独立 thread；已有绑定则跳转到对应 thread',
    '',
    '在 thread 中发送普通文本消息将交给 Claude 处理。',
    '`/remove`、`/attach`、`/create` 等 session 管理命令请在 CLI 中使用。',
  ].join('\n');
}

export function getMattermostWelcomeText(username: string, sessionCount: number, activeCount: number): string {
  return [
    `**mm-coder** 已连接 (\`${username}\`)`,
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
  private _stopped = false;

  constructor(config: MattermostConfig) {
    this._config = config;
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

    // Send welcome message
    await this.sendMessage(
      { plugin: 'mattermost', channelId: this._config.channelId, threadId: '' },
      { kind: 'text', text: getMattermostWelcomeText(me.username, opts.sessionCount ?? 0, opts.activeCount ?? 0) },
    );
  }

  /** Graceful shutdown: stop WebSocket reconnect loop and close connection */
  async disconnect(): Promise<void> {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
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

  /** Start WebSocket connection to receive real-time events */
  private _startWebSocket(): void {
    if (this._stopped) return;

    const wsUrl = this._config.url.replace(/^https?:\/\//, (m) =>
      m.startsWith('https') ? 'wss://' : 'ws://',
    ) + '/api/v4/websocket';

    const ws = new WebSocket(wsUrl);
    this._ws = ws;

    ws.addEventListener('open', () => {
      // Authenticate the WebSocket connection
      ws.send(JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token: this._config.token },
      }));
    });

    ws.addEventListener('message', (event) => {
      this._handleWsMessage(event.data as string);
    });

    ws.addEventListener('close', () => {
      this._ws = null;
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

  private _handleWsMessage(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
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

    // Ignore messages from the bot itself
    if (post.user_id === this._botUserId) return;

    // Only handle messages in the configured channel or threads in it
    const channelId = post.channel_id as string | undefined;
    if (channelId !== this._config.channelId) return;

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

    for (const h of this._handlers) h(incoming);
  }

  async sendMessage(target: MessageTarget, content: MessageContent): Promise<void> {
    await this._apiRequest('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify({
        channel_id: this._config.channelId,
        root_id: target.threadId,
        message: this._toText(content),
      }),
    });
  }

  async createLiveMessage(target: MessageTarget, content: MessageContent): Promise<string> {
    const res = await this._apiRequest('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify({
        channel_id: this._config.channelId,
        root_id: target.threadId,
        message: this._toText(content),
      }),
    });
    const data = await res.json() as { id: string };
    return data.id;
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

  async requestApproval(target: MessageTarget, request: ApprovalRequest): Promise<void> {
    const actions = request.scopeOptions.map(scope => ({
      id: `approve_${scope}_${request.requestId}`,
      name: scope === 'once' ? 'Approve (once)' : 'Approve (session)',
      type: 'button',
      style: 'good',
    }));
    actions.push({
      id: `deny_${request.requestId}`,
      name: 'Deny',
      type: 'button',
      style: 'danger',
    });

    await this._apiRequest('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify({
        channel_id: this._config.channelId,
        root_id: target.threadId,
        message: `**Approval required** — \`${request.toolName}\`\n${request.toolInputSummary}`,
        props: {
          attachments: [{
            title: `Tool: ${request.toolName}`,
            text: request.toolInputSummary,
            color: request.riskLevel === 'high' ? '#FF0000' : request.riskLevel === 'medium' ? '#FFA500' : '#00FF00',
            actions,
          }],
        },
      }),
    });
  }
}
