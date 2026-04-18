import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MattermostPlugin,
  loadMattermostConfig,
  createConnectedMattermostPlugin,
  getMattermostCommandHelpText,
  getMattermostWelcomeText,
} from '../../src/plugins/im/mattermost.js';

type WSStub = {
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  __emit: (event: string, payload?: unknown) => void;
};

const BASE_URL = 'https://mm.example.com';
const TOKEN = 'test-token';
const CHANNEL_ID = 'ch1';

function makeFetchMock(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  });
}

describe('Mattermost config loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('帮助文案包含所有 IM 命令', () => {
    const text = getMattermostCommandHelpText();
    expect(text).toContain('/help');
    expect(text).toContain('/list');
    expect(text).toContain('/status');
    expect(text).toContain('/open <sessionName>');
    expect(text).toContain('/takeover <sessionName>');
    expect(text).toContain('/takeover-force <sessionName>');
    expect(text).toContain('普通文本消息');
    expect(text).toContain('请在 CLI 中使用');
  });

  test('欢迎文案包含 bot 名称和帮助信息', () => {
    const text = getMattermostWelcomeText('bot-user', 3, 1);
    expect(text).toContain('bot-user');
    expect(text).toContain('/help');
  });

  test('支持顶层配置结构', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      url: BASE_URL,
      token: TOKEN,
      channelId: CHANNEL_ID,
      reconnectIntervalMs: 2000,
    }));

    const cfg = loadMattermostConfig(configPath);
    expect(cfg.url).toBe(BASE_URL);
    expect(cfg.token).toBe(TOKEN);
    expect(cfg.channelId).toBe(CHANNEL_ID);
    expect(cfg.reconnectIntervalMs).toBe(2000);
  });

  test('支持 mattermost 分组配置结构', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mattermost: {
        url: BASE_URL,
        token: TOKEN,
        channelId: CHANNEL_ID,
      },
    }));

    const cfg = loadMattermostConfig(configPath);
    expect(cfg.url).toBe(BASE_URL);
    expect(cfg.token).toBe(TOKEN);
    expect(cfg.channelId).toBe(CHANNEL_ID);
  });

  test('支持 im.mattermost 多 IM 配置结构', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      im: {
        mattermost: {
          url: BASE_URL,
          token: TOKEN,
          channelId: CHANNEL_ID,
          reconnectIntervalMs: 3000,
        },
      },
    }));

    const cfg = loadMattermostConfig(configPath);
    expect(cfg.url).toBe(BASE_URL);
    expect(cfg.token).toBe(TOKEN);
    expect(cfg.channelId).toBe(CHANNEL_ID);
    expect(cfg.reconnectIntervalMs).toBe(3000);
  });

  test('缺失必填字段时报错', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ url: BASE_URL, token: TOKEN }));

    expect(() => loadMattermostConfig(configPath)).toThrow(/channelId/);
  });

  test('reconnectIntervalMs 非法时报错', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      url: BASE_URL,
      token: TOKEN,
      channelId: CHANNEL_ID,
      reconnectIntervalMs: -1,
    }));

    expect(() => loadMattermostConfig(configPath)).toThrow(/reconnectIntervalMs/);
  });

  test('createConnectedMattermostPlugin 会加载配置并执行 connect', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      url: BASE_URL,
      token: TOKEN,
      channelId: CHANNEL_ID,
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'bot-user-1', username: 'bot' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'post1' }),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchMock);

    const plugin = await createConnectedMattermostPlugin(configPath);
    expect(plugin).toBeInstanceOf(MattermostPlugin);
    expect(fetchMock).toHaveBeenCalledTimes(2); // GET /users/me + POST welcome message
    const [, welcomeOpts] = fetchMock.mock.calls[1];
    const welcomeBody = JSON.parse(welcomeOpts.body);
    expect(welcomeBody.message).toContain('/help');
  });
});

describe('MattermostPlugin', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let wsInstances: WSStub[];

  beforeEach(() => {
    fetchSpy = makeFetchMock({ id: 'post1' });
    vi.stubGlobal('fetch', fetchSpy);

    wsInstances = [];
    const WS = vi.fn().mockImplementation(() => {
      const listeners = new Map<string, Array<(arg?: unknown) => void>>();
      const ws: WSStub = {
        addEventListener: vi.fn((event: string, handler: (arg?: unknown) => void) => {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event)!.push(handler);
        }),
        close: vi.fn(() => {
          for (const h of listeners.get('close') ?? []) h();
        }),
        send: vi.fn(),
        __emit: (event: string, payload?: unknown) => {
          for (const h of listeners.get(event) ?? []) h(payload);
        },
      };
      wsInstances.push(ws);
      return ws;
    });
    vi.stubGlobal('WebSocket', WS as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('connect 会校验 token 并启动 websocket 认证', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await plugin.connect();

    expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/api/v4/users/me`, expect.anything());
    expect(wsInstances).toHaveLength(1);
    wsInstances[0].__emit('open');
    expect(wsInstances[0].send).toHaveBeenCalled();
  });

  test('onMessage 能接收 websocket posted 事件', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const received: string[] = [];
    plugin.onMessage((msg) => received.push(msg.text));
    await plugin.connect();

    const post = {
      id: 'post-1',
      user_id: 'user-x',
      channel_id: CHANNEL_ID,
      root_id: '',
      message: 'hello from ws',
      create_at: Date.now(),
    };

    wsInstances[0].__emit('message', {
      data: JSON.stringify({
        event: 'posted',
        data: { post: JSON.stringify(post) },
      }),
    });

    expect(received).toEqual(['hello from ws']);
  });

  test('sendMessage 使用 target.channelId，且空 threadId 不发送 root_id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.sendMessage({ plugin: 'mattermost', channelId: 'ch-other', threadId: '' }, { kind: 'text', text: 'hello' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts`);
    const body = JSON.parse(opts.body);
    expect(body.channel_id).toBe('ch-other');
    expect(body.message).toBe('hello');
    expect(body.root_id).toBeUndefined();
  });

  test('sendMessage 调用正确 API endpoint', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.sendMessage({ plugin: 'mattermost', threadId: 'root-post-id' }, { kind: 'text', text: 'hello' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts`);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.message).toBe('hello');
    expect(body.root_id).toBe('root-post-id');
  });

  test('updateMessage 调用 PUT /api/v4/posts/:id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.updateMessage('post-abc', { kind: 'text', text: 'updated' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts/post-abc`);
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body);
    expect(body.message).toBe('updated');
  });

  test('createLiveMessage 创建顶层 post 时不发送 root_id 并返回 id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    const msgId = await plugin.createLiveMessage({ plugin: 'mattermost', channelId: 'ch-top', threadId: '' }, { kind: 'text', text: 'live top' });

    expect(msgId).toBe('post1');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.channel_id).toBe('ch-top');
    expect(body.root_id).toBeUndefined();
  });

  test('createLiveMessage 创建 post 并返回 id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    const msgId = await plugin.createLiveMessage({ plugin: 'mattermost', threadId: 'root1' }, { kind: 'text', text: 'live' });

    expect(msgId).toBe('post1');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  test('heartbeat 超时后主动 close 并重连', async () => {
    vi.useFakeTimers();

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({
      url: BASE_URL,
      token: TOKEN,
      channelId: CHANNEL_ID,
      reconnectIntervalMs: 10,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 120,
    } as any);

    await plugin.connect();
    wsInstances[0].__emit('open');

    vi.advanceTimersByTime(200);

    expect(wsInstances[0].close).toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(wsInstances.length).toBeGreaterThan(1);

    vi.useRealTimers();
  });

  test('收到 websocket 消息会刷新活性时间戳', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');

    const before = (plugin as any)._lastWsMessageAt ?? 0;
    wsInstances[0].__emit('message', { data: JSON.stringify({ event: 'hello', data: {} }) });
    const after = (plugin as any)._lastWsMessageAt ?? 0;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('收到 websocket heartbeat ack 会刷新 ack 时间戳', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');

    const before = (plugin as any)._lastHeartbeatAckAt ?? 0;
    wsInstances[0].__emit('message', { data: JSON.stringify({ seq_reply: 1, status: 'OK' }) });
    const after = (plugin as any)._lastHeartbeatAckAt ?? 0;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('sendTyping 发送 typing 指示请求', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    await plugin.sendTyping({ plugin: 'mattermost', threadId: 'root1' } as any);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts`);
    const body = JSON.parse(opts.body);
    expect(body.props?.typing).toBe(true);
  });
  test('requestApproval 发送带 attachments 的消息', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.requestApproval({ plugin: 'mattermost', threadId: 'root1' }, {
      requestId: 'req1',
      sessionName: 'sess1',
      messageId: 'msg1',
      toolName: 'bash',
      toolInputSummary: 'ls -la',
      riskLevel: 'low',
      capability: 'bash',
      scopeOptions: ['once', 'session'],
      timeoutSeconds: 60,
    } as any);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts`);
    const body = JSON.parse(opts.body);
    expect(body.props?.attachments).toBeDefined();
  });

  test('getConnectionHealth 返回 ws/subscription 健康摘要', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');

    const health = plugin.getConnectionHealth();
    expect(typeof health.wsHealthy).toBe('boolean');
    expect(typeof health.subscriptionHealthy).toBe('boolean');
    expect(typeof health.lastWsOpenAt).toBe('number');
  });

  test('disconnect 会关闭 websocket', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await plugin.connect();
    expect(wsInstances).toHaveLength(1);

    await plugin.disconnect();
    expect(wsInstances[0].close).toHaveBeenCalled();
  });

  test('Authorization header 包含 token', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.sendMessage({ plugin: 'mattermost', threadId: 'root1' }, { kind: 'text', text: 'hi' });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});
